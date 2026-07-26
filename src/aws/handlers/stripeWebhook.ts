import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { getPlanIdFromStripePriceId, isStripeConfigured, normalizeBillingCycle, normalizeBillingStatus, normalizePlanId } from '../shared/billing.js';
import { awsEnv } from '../shared/env.js';
import {
  findOrganisationIdByStripeCustomerId,
  findOrganisationIdByStripeSubscriptionId,
  updateOrganisationBillingProfile,
} from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

function toStripeBillingStatus(status: string) {
  if (status === 'trialing' || status === 'active' || status === 'past_due' || status === 'canceled') {
    return status;
  }
  return 'inactive';
}

function toIsoDate(timestamp: number | null | undefined) {
  return typeof timestamp === 'number' && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null;
}

async function syncSubscription(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null;
  const organisationIdFromMetadata = subscription.metadata.organisationId ? Number(subscription.metadata.organisationId) : null;
  const organisationId =
    organisationIdFromMetadata
    ?? (subscription.id ? await findOrganisationIdByStripeSubscriptionId(subscription.id) : null)
    ?? (customerId ? await findOrganisationIdByStripeCustomerId(customerId) : null);

  if (!organisationId) {
    return;
  }

  const firstItem = subscription.items.data[0];
  const priceId = firstItem?.price?.id ?? null;
  const metadataPlanId = subscription.metadata.planId?.trim();
  const planIdFromMetadata =
    metadataPlanId === 'capture' || metadataPlanId === 'control' || metadataPlanId === 'operations' || metadataPlanId === 'enterprise'
      ? normalizePlanId(metadataPlanId)
      : null;
  const inferredPlanId = planIdFromMetadata ?? getPlanIdFromStripePriceId(priceId) ?? 'legacy';
  const billingCycle = subscription.metadata.billingCycle ? normalizeBillingCycle(subscription.metadata.billingCycle) : 'monthly';

  await updateOrganisationBillingProfile({
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

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    if (!isStripeConfigured() || !awsEnv.stripeSecretKey || !awsEnv.stripeWebhookSecret) {
      return jsonResponse(503, {
        success: false,
        error: 'billing_not_configured',
        message: 'Stripe webhook handling is not configured for this workspace.',
      });
    }

    const stripeSignature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
    if (!stripeSignature || !event.body) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_webhook_request',
        message: 'Stripe signature and payload are required.',
      });
    }

    const stripe = new Stripe(awsEnv.stripeSecretKey, {
      apiVersion: '2026-06-24.dahlia',
    });

    const rawBody = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8');
    const stripeEvent = stripe.webhooks.constructEvent(rawBody, stripeSignature, awsEnv.stripeWebhookSecret);

    switch (stripeEvent.type) {
      case 'checkout.session.completed': {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
        if (subscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(subscriptionId);
          await syncSubscription(subscription);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await syncSubscription(subscription);
        break;
      }
      default:
        break;
    }

    return jsonResponse(200, { success: true, received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not process Stripe webhook.';
    return jsonResponse(400, {
      success: false,
      error: 'stripe_webhook_failed',
      message,
    });
  }
}
