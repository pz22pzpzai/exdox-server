import Stripe from 'stripe';

import type { OrganisationBillingSummary } from '../types.js';
import { normalizeBillingStatus } from './billing.js';
import { clearMissingStripeBillingReferences, isStripeResourceMissing } from './stripeSubscription.js';
import { awsEnv } from './env.js';

function toStripeBillingStatus(status: string) {
  if (status === 'trialing' || status === 'active' || status === 'past_due' || status === 'canceled') {
    return status;
  }
  return 'inactive';
}

function toIsoDate(timestamp: number | null | undefined) {
  return typeof timestamp === 'number' && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null;
}

function getCancellationScheduledFor(subscription: Stripe.Subscription) {
  if (!subscription.cancel_at_period_end) {
    return null;
  }

  return (
    toIsoDate(subscription.cancel_at)
    ?? toIsoDate(subscription.trial_end)
    ?? toIsoDate(subscription.billing_cycle_anchor)
  );
}

export async function hydrateBillingSummaryFromStripe(
  summary: OrganisationBillingSummary,
  organisationId?: number,
): Promise<OrganisationBillingSummary> {
  if (!awsEnv.stripeSecretKey || !summary.stripeSubscriptionId) {
    return summary;
  }

  try {
    const stripe = new Stripe(awsEnv.stripeSecretKey, {
      apiVersion: '2026-06-24.dahlia',
    });
    const subscription = await stripe.subscriptions.retrieve(summary.stripeSubscriptionId);

    return {
      ...summary,
      status: normalizeBillingStatus(toStripeBillingStatus(subscription.status), summary.planId),
      trialEndsAt: toIsoDate(subscription.trial_end) ?? summary.trialEndsAt,
      cancellationScheduledFor: getCancellationScheduledFor(subscription),
      stripeCustomerId:
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer?.id ?? summary.stripeCustomerId,
      stripeSubscriptionId: subscription.status === 'canceled' ? null : subscription.id,
    };
  } catch (error) {
    if (organisationId && isStripeResourceMissing(error)) {
      console.info('Clearing a Stripe subscription reference that is not present in the configured Stripe account.', {
        organisationId,
      });
      return clearMissingStripeBillingReferences(organisationId);
    }
    console.warn('Could not hydrate billing summary from Stripe.', {
      subscriptionId: summary.stripeSubscriptionId,
      message: error instanceof Error ? error.message : 'Unknown Stripe error',
    });
    return summary;
  }
}
