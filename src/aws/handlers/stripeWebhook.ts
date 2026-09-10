import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { fulfillAccountingIntegrationUnlock, isAccountingIntegrationUnlockSession, removeUnusedAccountingIntegrationCredit } from '../shared/accountingIntegrationUnlock.js';
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

    try {
      switch (stripeEvent.type) {
        case 'checkout.session.completed': {
          const session = stripeEvent.data.object as Stripe.Checkout.Session;
          if (isAccountingIntegrationUnlockSession(session)) {
            if (session.payment_status === 'paid') {
              await fulfillAccountingIntegrationUnlock(session, stripe);
            }
            break;
          }
          const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId);
            await syncStripeSubscription(subscription);
          }
          break;
        }
        case 'checkout.session.async_payment_succeeded': {
          const session = stripeEvent.data.object as Stripe.Checkout.Session;
          if (isAccountingIntegrationUnlockSession(session)) {
            await fulfillAccountingIntegrationUnlock(session, stripe);
          }
          break;
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = stripeEvent.data.object as Stripe.Subscription;
          await syncStripeSubscription(subscription);
          break;
        }
        case 'customer.subscription.deleted': {
          const subscription = stripeEvent.data.object as Stripe.Subscription;
          await removeUnusedAccountingIntegrationCredit(subscription, stripe);
          await syncStripeSubscription(subscription);
          break;
        }
        default:
          break;
      }

      return jsonResponse(200, { success: true, received: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not synchronise the Stripe event.';

      // Stripe has already authenticated this event. Do not turn an internal
      // database or follow-up API failure into an endless Stripe retry loop.
      // Billing reads reconcile directly with Stripe, so the next billing or
      // login request repairs any state that was not saved here.
      console.error('Stripe webhook sync deferred', {
        requestId: event.requestContext.requestId,
        eventId: stripeEvent.id,
        eventType: stripeEvent.type,
        message,
      });

      const session = stripeEvent.type === 'checkout.session.completed' || stripeEvent.type === 'checkout.session.async_payment_succeeded'
        ? stripeEvent.data.object as Stripe.Checkout.Session
        : null;
      if (session && isAccountingIntegrationUnlockSession(session)) {
        return jsonResponse(500, { success: false, error: 'accounting_integration_fulfillment_failed', message: 'Stripe will retry the accounting integration payment fulfilment.' });
      }

      return jsonResponse(200, { success: true, received: true, deferred: true });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not process Stripe webhook.';
    const isSignatureFailure = error instanceof Stripe.errors.StripeSignatureVerificationError;

    // Never log the request body or Stripe signature. The request ID lets us trace
    // rejected webhook deliveries in CloudWatch without exposing payment data.
    console.error('Stripe webhook processing failed', {
      requestId: event.requestContext.requestId,
      message,
    });

    // Stripe should retry temporary processing failures. Only a malformed or
    // incorrectly signed request is a permanent client error.
    return jsonResponse(isSignatureFailure ? 400 : 500, {
      success: false,
      error: isSignatureFailure ? 'stripe_webhook_signature_invalid' : 'stripe_webhook_processing_failed',
      message: isSignatureFailure ? 'Stripe signature verification failed.' : 'Could not process Stripe webhook.',
    });
  }
}
