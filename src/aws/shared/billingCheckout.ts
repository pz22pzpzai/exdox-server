import Stripe from 'stripe';

import type { AuthenticatedUser } from '../types.js';
import {
  getPlanDefinition,
  isStripeConfigured,
  normalizeBillingCycle,
  normalizePlanId,
  resolveSelfServeSubscriptionSelection,
} from './billing.js';
import { getOrganisationBillingSummary, getOrganisationName, updateOrganisationBillingProfile } from './db.js';
import { awsEnv } from './env.js';
import { reconcileStripeSubscription } from './stripeSubscription.js';

type CheckoutError = Error & { statusCode?: number; code?: string };

export async function createSelfServeCheckoutSession(input: {
  user: AuthenticatedUser;
  planId: unknown;
  billingCycle: unknown;
  successUrl?: string;
  cancelUrl?: string;
}) {
  if (!isStripeConfigured() || !awsEnv.stripeSecretKey) {
    throw checkoutError(
      503,
      'billing_not_configured',
      'Online checkout is not available for this workspace yet. Contact contact@exdox.co.uk to change plans.',
    );
  }

  const planId = normalizePlanId(input.planId);
  const billingCycle = normalizeBillingCycle(input.billingCycle);
  const stripe = new Stripe(awsEnv.stripeSecretKey, {
    apiVersion: '2026-06-24.dahlia',
  });
  const storedBilling = await getOrganisationBillingSummary(input.user.organisationId);
  const billing = await reconcileStripeSubscription(input.user.organisationId, storedBilling, stripe);

  if (billing.stripeSubscriptionId && billing.status !== 'inactive' && billing.status !== 'canceled') {
    throw checkoutError(
      409,
      'subscription_already_exists',
      'This workspace already has an active or trial subscription. Use the billing portal to manage or cancel it.',
    );
  }

  if (billing.status === 'inactive' && planId !== billing.planId) {
    throw checkoutError(
      400,
      'checkout_selection_mismatch',
      'Start checkout for the plan selected during registration, or return to Pricing to choose a different package before registering.',
    );
  }

  const selection = resolveSelfServeSubscriptionSelection({
    planId: billing.status === 'inactive' ? billing.planId : planId,
    monthlyDocumentLimit:
      billing.status === 'inactive' ? billing.monthlyDocumentLimit : getPlanDefinition(planId).monthlyDocumentLimit,
    includedUsers: billing.status === 'inactive' ? billing.includedUsers : getPlanDefinition(planId).includedUsers,
  });
  const organisationName = await getOrganisationName(input.user.organisationId);
  const planDefinition = getPlanDefinition(selection.planId);
  let customerId = billing.stripeCustomerId;

  if (!customerId) {
    const customer = await stripe.customers.create({
      email: input.user.email,
      name: organisationName,
      metadata: {
        organisationId: String(input.user.organisationId),
        planId: selection.planId,
      },
    });
    customerId = customer.id;
    await updateOrganisationBillingProfile({
      organisationId: input.user.organisationId,
      stripeCustomerId: customerId,
    });
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    customer: customerId,
    success_url: input.successUrl || awsEnv.stripeCheckoutSuccessUrl,
    cancel_url: input.cancelUrl || awsEnv.stripeCheckoutCancelUrl,
    payment_method_collection: 'always',
    line_items: [{
      price_data: {
        currency: 'gbp',
        product_data: {
          name: `Exdox ${selection.label}`,
          metadata: {
            planId: selection.planId,
            includedUsers: String(selection.includedUsers),
            monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
          },
        },
        unit_amount: selection.monthlyAmountPence,
        recurring: { interval: 'month' },
      },
      quantity: 1,
    }],
    metadata: buildCheckoutMetadata(input.user.organisationId, selection, billingCycle),
    subscription_data: {
      trial_period_days: planDefinition.trialDays ?? undefined,
      trial_settings: {
        end_behavior: {
          missing_payment_method: 'cancel',
        },
      },
      metadata: buildCheckoutMetadata(input.user.organisationId, selection, billingCycle),
    },
  });

  return {
    checkoutUrl: session.url,
    sessionId: session.id,
  };
}

export function buildSignupCheckoutReturnUrl(email: string, checkoutStatus: 'success' | 'cancelled') {
  const loginUrl = new URL(awsEnv.confirmEmailLoginUrl);
  loginUrl.searchParams.set('email', email);
  loginUrl.searchParams.set('checkout', checkoutStatus);
  loginUrl.searchParams.set('confirmation', 'required');
  return loginUrl.toString();
}

function buildCheckoutMetadata(
  organisationId: number,
  selection: ReturnType<typeof resolveSelfServeSubscriptionSelection>,
  billingCycle: ReturnType<typeof normalizeBillingCycle>,
) {
  return {
    organisationId: String(organisationId),
    planId: selection.planId,
    billingCycle,
    includedUsers: String(selection.includedUsers),
    monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
    monthlyAmountPence: String(selection.monthlyAmountPence),
    termsVersion: '2026-07-26',
    termsAcceptanceSource: 'registration',
  };
}

function checkoutError(statusCode: number, code: string, message: string) {
  const error = new Error(message) as CheckoutError;
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
