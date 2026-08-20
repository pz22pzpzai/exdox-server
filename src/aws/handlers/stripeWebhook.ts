import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { isStripeConfigured } from '../shared/billing.js';
import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';
import { syncStripeSubscription } from '../shared/stripeSubscription.js';

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
          await syncStripeSubscription(subscription);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const subscription = stripeEvent.data.object as Stripe.Subscription;
        await syncStripeSubscription(subscription);
        break;
      }
      default:
        break;
    }

    return jsonResponse(200, { success: true, received: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not process Stripe webhook.';

    // Never log the request body or Stripe signature. The request ID lets us trace
    // rejected webhook deliveries in CloudWatch without exposing payment data.
    console.error('Stripe webhook processing failed', {
      requestId: event.requestContext.requestId,
      message,
    });

    return jsonResponse(400, {
      success: false,
      error: 'stripe_webhook_failed',
      message,
    });
  }
}
