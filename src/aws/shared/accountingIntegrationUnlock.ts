import Stripe from 'stripe';

import type { AuthenticatedUser } from '../types.js';
import { isStripeConfigured } from './billing.js';
import { getOrganisationBillingAccessState, getOrganisationBillingSummary } from './db.js';
import { awsEnv } from './env.js';
import { getReceiptJsonObject, putReceiptJsonObject } from './s3.js';
import { reconcileStripeSubscription } from './stripeSubscription.js';

export const ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE = 500;
export const ACCOUNTING_INTEGRATION_UNLOCK_ACTION = 'accounting_integration_trial_unlock';
const SOLE_TRADER_XERO_MONTHLY_PENCE = 1000;

function isSoleTraderBaseSubscription(subscription: Stripe.Subscription) {
  return subscription.metadata.includedUsers === '1'
    && subscription.metadata.monthlyDocumentLimit === '100'
    && subscription.items.data[0]?.price.unit_amount === 500
    && subscription.items.data[0]?.price.currency === 'gbp';
}

type AccountingIntegrationUnlockRecord = {
  version: 1;
  organisationId: number;
  status: 'pending' | 'unlocked';
  checkoutSessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  paymentIntentId: string | null;
  creditInvoiceItemId: string | null;
  amountPence: number;
  createdAt: string;
  unlockedAt: string | null;
  creditVoidedAt: string | null;
};

type UnlockError = Error & { statusCode?: number; code?: string };

function recordKey(organisationId: number) {
  return `billing-addons/org-${organisationId}-accounting-integration.json`;
}

function unlockError(statusCode: number, code: string, message: string) {
  const error = new Error(message) as UnlockError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function stripeClient() {
  if (!isStripeConfigured() || !awsEnv.stripeSecretKey) {
    throw unlockError(503, 'billing_not_configured', 'Online payment is not available for this workspace yet.');
  }
  return new Stripe(awsEnv.stripeSecretKey, { apiVersion: '2026-06-24.dahlia' });
}

export async function getAccountingIntegrationUnlock(organisationId: number) {
  try {
    return await getReceiptJsonObject<AccountingIntegrationUnlockRecord>(recordKey(organisationId));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return null;
    throw error;
  }
}

export async function getAccountingIntegrationAccess(organisationId: number) {
  const [billing, unlock] = await Promise.all([
    getOrganisationBillingAccessState(organisationId),
    getAccountingIntegrationUnlock(organisationId),
  ]);
  const billingStatus = billing.billingStatus;
  const trialOpen = billingStatus === 'trialing' && (!billing.trialEndsAt || Date.parse(billing.trialEndsAt) > Date.now());
  const trialUnlockPurchased = unlock?.status === 'unlocked' && unlock.stripeSubscriptionId === billing.stripeSubscriptionId;
  const subscription = billing.stripeSubscriptionId && (billingStatus === 'active' || trialOpen)
    ? await stripeClient().subscriptions.retrieve(billing.stripeSubscriptionId)
    : null;
  const soleTraderBase = subscription ? isSoleTraderBaseSubscription(subscription) : false;
  const soleTraderXeroActive = subscription?.metadata.includedUsers === '1'
    && subscription.metadata.monthlyDocumentLimit === '100'
    && subscription.items.data[0]?.price.unit_amount === SOLE_TRADER_XERO_MONTHLY_PENCE
    && (billingStatus === 'active' || (trialOpen && subscription.metadata.xeroUpgrade === 'true'));
  const soleTraderXeroUpgradeEligible = soleTraderBase && (billingStatus === 'active' || trialOpen);
  const upgradedTrial = subscription?.metadata.xeroUpgrade === 'true' && !soleTraderBase;
  return {
    billingStatus,
    available: (billingStatus === 'active' && !soleTraderBase) || (trialOpen && (upgradedTrial || (trialUnlockPurchased && !soleTraderBase))),
    trialUnlockEligible: trialOpen && !trialUnlockPurchased && !soleTraderBase,
    soleTraderXeroUpgradeEligible,
    soleTraderXeroActive,
    trialUnlockPurchasedAt: trialUnlockPurchased && !upgradedTrial ? unlock.unlockedAt : null,
  };
}

export async function createAccountingIntegrationUnlockCheckout(user: AuthenticatedUser) {
  const stripe = stripeClient();
  const billing = await reconcileStripeSubscription(
    user.organisationId,
    await getOrganisationBillingSummary(user.organisationId),
    stripe,
  );
  const existing = await getAccountingIntegrationUnlock(user.organisationId);
  const subscription = billing.stripeSubscriptionId ? await stripe.subscriptions.retrieve(billing.stripeSubscriptionId) : null;
  const soleTraderBase = subscription ? isSoleTraderBaseSubscription(subscription) : false;

  if (billing.status !== 'trialing' && !(billing.status === 'active' && soleTraderBase)) {
    throw unlockError(409, 'trial_unlock_unavailable', 'The £5 accounting integration unlock is available only during an active free trial.');
  }
  if (!billing.stripeCustomerId || !billing.stripeSubscriptionId) {
    throw unlockError(409, 'trial_subscription_required', 'Start the free trial with Stripe before unlocking accounting integrations.');
  }
  if (existing?.status === 'unlocked' && existing.stripeSubscriptionId === billing.stripeSubscriptionId && !soleTraderBase) {
    return { checkoutUrl: null, sessionId: existing.checkoutSessionId, alreadyUnlocked: true };
  }

  if (existing?.status === 'pending' && existing.stripeSubscriptionId === billing.stripeSubscriptionId) {
    const pendingSession = await stripe.checkout.sessions.retrieve(existing.checkoutSessionId);
    if (pendingSession.status === 'complete' && pendingSession.payment_status === 'paid') {
      await fulfillAccountingIntegrationUnlock(pendingSession, stripe);
      return { checkoutUrl: null, sessionId: pendingSession.id, alreadyUnlocked: true };
    }
    if (pendingSession.status === 'open' && pendingSession.url) {
      return { checkoutUrl: pendingSession.url, sessionId: pendingSession.id, alreadyUnlocked: false };
    }
  }

  const successUrl = 'https://exdox.co.uk/settings/integrations?accounting_unlock=success&session_id={CHECKOUT_SESSION_ID}';
  const cancelUrl = 'https://exdox.co.uk/settings/integrations?accounting_unlock=cancelled';
  const generation = existing?.checkoutSessionId ?? 'initial';
  const metadata = {
    action: ACCOUNTING_INTEGRATION_UNLOCK_ACTION,
    organisationId: String(user.organisationId),
    stripeSubscriptionId: billing.stripeSubscriptionId,
    amountPence: String(ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE),
    ...(soleTraderBase ? { soleTraderXeroUpgrade: 'true' } : {}),
  };
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    ...(soleTraderBase ? { payment_method_types: ['card' as const] } : {}),
    customer: billing.stripeCustomerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    line_items: [{
      price_data: {
        currency: 'gbp',
        unit_amount: ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE,
        product_data: { name: soleTraderBase ? 'Exdox sole trader Xero upgrade' : 'Exdox accounting integration trial unlock' },
      },
      quantity: 1,
    }],
    metadata,
    payment_intent_data: { metadata, ...(soleTraderBase ? { setup_future_usage: 'off_session' as const } : {}) },
  }, { idempotencyKey: `accounting-integration-unlock-${user.organisationId}-${billing.stripeSubscriptionId}-${generation}` });

  if (!session.url) {
    throw unlockError(502, 'checkout_url_missing', 'Stripe did not return a checkout page. Please try again.');
  }
  const now = new Date().toISOString();
  await putReceiptJsonObject(recordKey(user.organisationId), {
    version: 1,
    organisationId: user.organisationId,
    status: 'pending',
    checkoutSessionId: session.id,
    stripeCustomerId: billing.stripeCustomerId,
    stripeSubscriptionId: billing.stripeSubscriptionId,
    paymentIntentId: null,
    creditInvoiceItemId: null,
    amountPence: ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE,
    createdAt: now,
    unlockedAt: null,
    creditVoidedAt: null,
  } satisfies AccountingIntegrationUnlockRecord);
  return { checkoutUrl: session.url, sessionId: session.id, alreadyUnlocked: false };
}

export async function confirmAccountingIntegrationUnlock(user: AuthenticatedUser, sessionId: string) {
  if (!sessionId.startsWith('cs_')) {
    throw unlockError(400, 'invalid_checkout_session', 'The Stripe checkout reference is invalid.');
  }
  const stripe = stripeClient();
  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (Number(session.metadata?.organisationId) !== user.organisationId) {
    throw unlockError(403, 'checkout_session_mismatch', 'This Stripe checkout does not belong to the current workspace.');
  }
  return fulfillAccountingIntegrationUnlock(session, stripe);
}

export function isAccountingIntegrationUnlockSession(session: Stripe.Checkout.Session) {
  return session.metadata?.action === ACCOUNTING_INTEGRATION_UNLOCK_ACTION;
}

export async function fulfillAccountingIntegrationUnlock(session: Stripe.Checkout.Session, stripe: Stripe) {
  if (!isAccountingIntegrationUnlockSession(session)) {
    throw unlockError(400, 'invalid_unlock_checkout', 'This Stripe payment is not an accounting integration unlock.');
  }
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    throw unlockError(409, 'unlock_payment_incomplete', 'The £5 payment has not completed yet.');
  }
  if (session.amount_total !== ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE || session.currency !== 'gbp') {
    throw unlockError(409, 'unlock_payment_amount_mismatch', 'The accounting integration payment amount could not be verified.');
  }

  const organisationId = Number(session.metadata?.organisationId);
  const metadataSubscriptionId = session.metadata?.stripeSubscriptionId;
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id;
  const paymentIntentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id ?? null;
  if (!Number.isFinite(organisationId) || organisationId <= 0 || !customerId || !metadataSubscriptionId) {
    throw unlockError(400, 'invalid_unlock_metadata', 'The accounting integration payment details are incomplete.');
  }

  const billing = await getOrganisationBillingSummary(organisationId);
  if (billing.stripeCustomerId !== customerId || billing.stripeSubscriptionId !== metadataSubscriptionId) {
    throw unlockError(403, 'unlock_subscription_mismatch', 'The Stripe payment does not match this workspace subscription.');
  }
  const existing = await getAccountingIntegrationUnlock(organisationId);
  if (existing?.status === 'unlocked' && existing.stripeSubscriptionId === metadataSubscriptionId) {
    return { unlocked: true, alreadyUnlocked: true, unlockedAt: existing.unlockedAt, creditAmountPence: existing.creditInvoiceItemId ? existing.amountPence : 0 };
  }

  if (session.metadata?.soleTraderXeroUpgrade === 'true') {
    const subscription = await stripe.subscriptions.retrieve(metadataSubscriptionId);
    if (isSoleTraderBaseSubscription(subscription)) {
      if (!paymentIntentId) {
        throw unlockError(409, 'xero_upgrade_payment_method_missing', 'Stripe did not return a payment method for the monthly Xero subscription. Please contact billing support.');
      }
      const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
      const paymentMethodId = typeof paymentIntent.payment_method === 'string'
        ? paymentIntent.payment_method : paymentIntent.payment_method?.id;
      if (!paymentMethodId) {
        throw unlockError(409, 'xero_upgrade_payment_method_missing', 'Stripe did not return a payment method for the monthly Xero subscription. Please contact billing support.');
      }
      const item = subscription.items.data[0]!;
      const productId = typeof item.price.product === 'string' ? item.price.product : item.price.product.id;
      const price = await stripe.prices.create({
        currency: 'gbp',
        unit_amount: SOLE_TRADER_XERO_MONTHLY_PENCE,
        recurring: { interval: 'month' },
        product: productId,
        metadata: { planId: 'capture', includedUsers: '1', monthlyDocumentLimit: '100', xeroUpgrade: 'true' },
      }, { idempotencyKey: `sole-trader-xero-price-${subscription.id}` });
      const updated = await stripe.subscriptions.update(subscription.id, {
        items: [{ id: item.id, price: price.id, quantity: 1 }],
        metadata: { ...subscription.metadata, xeroUpgrade: 'true', monthlyAmountPence: String(SOLE_TRADER_XERO_MONTHLY_PENCE) },
        default_payment_method: paymentMethodId,
        proration_behavior: 'none',
      });
      if (updated.pending_update || updated.items.data[0]?.price.unit_amount !== SOLE_TRADER_XERO_MONTHLY_PENCE) {
        throw unlockError(409, 'xero_upgrade_pending', 'Stripe has not confirmed the £10 monthly subscription yet. Please try again.');
      }
    } else if (subscription.metadata.xeroUpgrade !== 'true') {
      throw unlockError(409, 'xero_upgrade_plan_changed', 'The sole trader plan changed before the Xero upgrade completed. Contact billing support.');
    }
    const unlockedAt = new Date().toISOString();
    await putReceiptJsonObject(recordKey(organisationId), {
      version: 1, organisationId, status: 'unlocked', checkoutSessionId: session.id,
      stripeCustomerId: customerId, stripeSubscriptionId: metadataSubscriptionId,
      paymentIntentId, creditInvoiceItemId: null, amountPence: ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE,
      createdAt: existing?.createdAt ?? unlockedAt, unlockedAt, creditVoidedAt: null,
    } satisfies AccountingIntegrationUnlockRecord);
    return { unlocked: true, alreadyUnlocked: false, unlockedAt, creditAmountPence: 0 };
  }

  const credit = await stripe.invoiceItems.create({
    customer: customerId,
    subscription: metadataSubscriptionId,
    amount: -ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE,
    currency: 'gbp',
    description: 'Credit for £5 accounting integration trial unlock payment',
    discountable: false,
    metadata: {
      action: ACCOUNTING_INTEGRATION_UNLOCK_ACTION,
      organisationId: String(organisationId),
      checkoutSessionId: session.id,
    },
  }, { idempotencyKey: `accounting-integration-unlock-credit-${session.id}` });

  const unlockedAt = new Date().toISOString();
  await putReceiptJsonObject(recordKey(organisationId), {
    version: 1,
    organisationId,
    status: 'unlocked',
    checkoutSessionId: session.id,
    stripeCustomerId: customerId,
    stripeSubscriptionId: metadataSubscriptionId,
    paymentIntentId,
    creditInvoiceItemId: credit.id,
    amountPence: ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE,
    createdAt: existing?.createdAt ?? unlockedAt,
    unlockedAt,
    creditVoidedAt: null,
  } satisfies AccountingIntegrationUnlockRecord);
  return { unlocked: true, alreadyUnlocked: false, unlockedAt, creditAmountPence: ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE };
}

export async function removeUnusedAccountingIntegrationCredit(subscription: Stripe.Subscription, stripe: Stripe) {
  const organisationId = Number(subscription.metadata.organisationId);
  if (!Number.isFinite(organisationId) || organisationId <= 0) return;
  const record = await getAccountingIntegrationUnlock(organisationId);
  if (record?.status !== 'unlocked' || record.stripeSubscriptionId !== subscription.id || !record.creditInvoiceItemId) return;

  const invoiceItem = await stripe.invoiceItems.retrieve(record.creditInvoiceItemId);
  if (invoiceItem.invoice) return;
  await stripe.invoiceItems.del(record.creditInvoiceItemId);
  await putReceiptJsonObject(recordKey(organisationId), {
    ...record,
    creditInvoiceItemId: null,
    creditVoidedAt: new Date().toISOString(),
  } satisfies AccountingIntegrationUnlockRecord);
}

export async function hasUnusedAccountingIntegrationCredit(organisationId: number, subscriptionId: string, stripe: Stripe) {
  const record = await getAccountingIntegrationUnlock(organisationId);
  if (record?.status !== 'unlocked' || record.stripeSubscriptionId !== subscriptionId || !record.creditInvoiceItemId) return false;
  const invoiceItem = await stripe.invoiceItems.retrieve(record.creditInvoiceItemId);
  return !invoiceItem.invoice && invoiceItem.amount === -ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE;
}
