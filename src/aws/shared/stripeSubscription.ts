import Stripe from 'stripe';

import type { OrganisationBillingSummary } from '../types.js';
import {
  getPlanIdFromStripePriceId,
  isStripeConfigured,
  normalizeBillingCycle,
  normalizeBillingStatus,
  normalizePlanId,
} from './billing.js';
import {
  findOrganisationIdByStripeCustomerId,
  findOrganisationIdByStripeSubscriptionId,
  getOrganisationBillingSummary,
  updateOrganisationBillingProfile,
} from './db.js';
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

export function isStripeResourceMissing(error: unknown) {
  if (!error || typeof error !== 'object') {
    return false;
  }

  const stripeError = error as { code?: unknown; type?: unknown };
  return stripeError.code === 'resource_missing' && stripeError.type === 'StripeInvalidRequestError';
}

export async function clearMissingStripeBillingReferences(organisationId: number) {
  return updateOrganisationBillingProfile({
    organisationId,
    billingStatus: 'inactive',
    trialEndsAt: null,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    cancellationScheduledFor: null,
  });
}

export async function syncStripeSubscription(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null;
  const organisationIdFromMetadata = subscription.metadata.organisationId
    ? Number(subscription.metadata.organisationId)
    : null;
  const organisationId =
    organisationIdFromMetadata
    ?? (subscription.id ? await findOrganisationIdByStripeSubscriptionId(subscription.id) : null)
    ?? (customerId ? await findOrganisationIdByStripeCustomerId(customerId) : null);

  if (!organisationId) {
    return null;
  }

  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price?.id ?? null;
  const metadataPlanId = subscription.metadata.planId?.trim();
  const planIdFromMetadata =
    metadataPlanId === 'capture'
    || metadataPlanId === 'control'
    || metadataPlanId === 'operations'
    || metadataPlanId === 'enterprise'
      ? normalizePlanId(metadataPlanId)
      : null;
  const inferredPlanId = planIdFromMetadata ?? getPlanIdFromStripePriceId(priceId) ?? 'legacy';
  const billingCycle = subscription.metadata.billingCycle
    ? normalizeBillingCycle(subscription.metadata.billingCycle)
    : 'monthly';

  return updateOrganisationBillingProfile({
    organisationId,
    billingPlan: inferredPlanId,
    billingStatus: normalizeBillingStatus(toStripeBillingStatus(subscription.status), inferredPlanId),
    billingCycle,
    trialEndsAt: toIsoDate(subscription.trial_end),
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.status === 'canceled' ? null : subscription.id,
    cancellationScheduledFor: subscription.cancel_at_period_end
      ? toIsoDate(subscription.cancel_at) ?? toIsoDate(subscription.trial_end) ?? toIsoDate(subscription.billing_cycle_anchor)
      : null,
  });
}

export async function reconcileStripeSubscription(
  organisationId: number,
  currentBilling?: OrganisationBillingSummary,
  stripeClient?: Stripe,
) {
  const billing = currentBilling ?? await getOrganisationBillingSummary(organisationId);
  if (!isStripeConfigured() || !awsEnv.stripeSecretKey || !billing.stripeCustomerId) {
    return billing;
  }

  if (
    billing.stripeSubscriptionId
    && billing.status !== 'inactive'
    && billing.status !== 'canceled'
  ) {
    return billing;
  }

  const stripe = stripeClient ?? new Stripe(awsEnv.stripeSecretKey, {
    apiVersion: '2026-06-24.dahlia',
  });
  let subscriptions: Stripe.ApiList<Stripe.Subscription>;
  try {
    subscriptions = await stripe.subscriptions.list({
      customer: billing.stripeCustomerId,
      status: 'all',
      limit: 10,
    });
  } catch (error) {
    if (isStripeResourceMissing(error)) {
      console.info('Clearing Stripe references that do not exist in the configured Stripe account.', {
        organisationId,
      });
      return clearMissingStripeBillingReferences(organisationId);
    }
    throw error;
  }
  const completedSubscription = subscriptions.data.find((subscription) =>
    subscription.status === 'trialing'
    || subscription.status === 'active'
    || subscription.status === 'past_due');

  if (!completedSubscription) {
    return billing;
  }

  await syncStripeSubscription(completedSubscription);
  return getOrganisationBillingSummary(organisationId);
}
