import Stripe from 'stripe';

import type { AuthenticatedUser } from '../types.js';
import {
  isStripeConfigured,
  normalizePlanId,
  resolveSelfServeSubscriptionSelection,
} from './billing.js';
import { getOrganisationBillingSummary } from './db.js';
import { awsEnv } from './env.js';
import { syncStripeSubscription } from './stripeSubscription.js';

type BillingUpgradeError = Error & { statusCode?: number; code?: string };

export async function upgradeSubscriptionPlan(input: {
  user: AuthenticatedUser;
  planId: unknown;
  monthlyDocumentLimit: unknown;
  includedUsers: unknown;
}) {
  if (!isStripeConfigured() || !awsEnv.stripeSecretKey) {
    throw billingUpgradeError(503, 'billing_not_configured', 'Online plan changes are not available for this workspace yet.');
  }

  const planId = normalizePlanId(input.planId);
  const selection = resolveSelfServeSubscriptionSelection({
    planId,
    monthlyDocumentLimit: Number(input.monthlyDocumentLimit),
    includedUsers: Number(input.includedUsers),
  });
  const stripe = new Stripe(awsEnv.stripeSecretKey, {
    apiVersion: '2026-06-24.dahlia',
  });
  const billing = await getOrganisationBillingSummary(input.user.organisationId);

  if (!billing.stripeSubscriptionId || !['trialing', 'active', 'past_due'].includes(billing.status)) {
    throw billingUpgradeError(409, 'subscription_not_active', 'Set up or reactivate billing before changing the plan.');
  }
  if (billing.cancellationScheduledFor) {
    throw billingUpgradeError(409, 'subscription_cancelling', 'Reactivate the subscription before changing the plan.');
  }
  if (
    (billing.monthlyDocumentLimit !== null && selection.monthlyDocumentLimit <= billing.monthlyDocumentLimit)
    || (billing.includedUsers !== null && selection.includedUsers <= billing.includedUsers)
  ) {
    throw billingUpgradeError(400, 'not_an_upgrade', 'Choose a package with a higher document and user allowance.');
  }

  const subscription = await stripe.subscriptions.retrieve(billing.stripeSubscriptionId);
  if (!['trialing', 'active', 'past_due'].includes(subscription.status)) {
    throw billingUpgradeError(409, 'subscription_not_active', 'Set up or reactivate billing before changing the plan.');
  }
  if (subscription.cancel_at_period_end) {
    throw billingUpgradeError(409, 'subscription_cancelling', 'Reactivate the subscription before changing the plan.');
  }
  const subscriptionItem = subscription.items.data[0];
  if (!subscriptionItem) {
    throw billingUpgradeError(409, 'subscription_item_missing', 'This subscription does not contain a billable plan item.');
  }

  const productId = typeof subscriptionItem.price.product === 'string'
    ? subscriptionItem.price.product
    : subscriptionItem.price.product?.id;
  const product = await resolveActiveSubscriptionProduct(stripe, productId);
  const price = await stripe.prices.create({
    currency: 'gbp',
    unit_amount: selection.monthlyAmountPence,
    recurring: { interval: 'month' },
    product: product.id,
    metadata: {
      planId: selection.planId,
      includedUsers: String(selection.includedUsers),
      monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
    },
  });
  const metadata = {
    ...subscription.metadata,
    organisationId: String(input.user.organisationId),
    planId: selection.planId,
    billingCycle: 'monthly',
    includedUsers: String(selection.includedUsers),
    monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
    monthlyAmountPence: String(selection.monthlyAmountPence),
    planChangeSource: 'exdox_billing_upgrade',
  };
  // Replace the existing item rather than adding another subscription item.
  // Pending updates keep the current allowance in force if Stripe cannot collect
  // the prorated adjustment immediately.
  const updatedSubscription = await stripe.subscriptions.update(subscription.id, {
    items: [{ id: subscriptionItem.id, price: price.id, quantity: 1 }],
    metadata,
    payment_behavior: 'pending_if_incomplete',
    proration_behavior: 'always_invoice',
  });

  if (updatedSubscription.pending_update) {
    throw billingUpgradeError(
      402,
      'upgrade_payment_pending',
      'Stripe could not complete the prorated plan adjustment. Your current plan and allowance have not changed. Update the payment method in Billing and try again.',
    );
  }

  await syncStripeSubscription(updatedSubscription);
  return getOrganisationBillingSummary(input.user.organisationId);
}

async function resolveActiveSubscriptionProduct(stripe: Stripe, currentProductId?: string) {
  if (currentProductId) {
    const currentProduct = await stripe.products.retrieve(currentProductId);
    if (!('deleted' in currentProduct) && currentProduct.active) {
      return currentProduct;
    }
  }

  const activeProducts = await stripe.products.list({ active: true, limit: 100 });
  const existingProduct = activeProducts.data.find(
    (product) => product.metadata.exdoxProductFamily === 'subscription',
  );
  if (existingProduct) {
    return existingProduct;
  }

  return stripe.products.create({
    name: 'Exdox subscriptions',
    metadata: { exdoxProductFamily: 'subscription' },
  });
}

function billingUpgradeError(statusCode: number, code: string, message: string) {
  const error = new Error(message) as BillingUpgradeError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
