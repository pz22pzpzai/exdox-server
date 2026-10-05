import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { fulfillAccountingIntegrationUnlock, isAccountingIntegrationUnlockSession, removeUnusedAccountingIntegrationCredit } from '../shared/accountingIntegrationUnlock.js';
import { isStripeConfigured } from '../shared/billing.js';
import { finishPaidContinuation } from '../shared/billingCheckout.js';
import { awsEnv } from '../shared/env.js';
import { sendFreeTrialStartedNotification } from '../shared/freeTrialNotification.js';
import { jsonResponse } from '../shared/http.js';
import { syncStripeSubscription } from '../shared/stripeSubscription.js';
import { flagAccountingInvoiceCharge, fulfillAccountingInvoiceCheckout } from './accountingInvoicePortal.js';

async function connectWebhook(event: APIGatewayProxyEventV2) {
  if (!awsEnv.stripeSecretKey || !awsEnv.stripeConnectWebhookSecret) return jsonResponse(503, { success: false, error: 'connect_webhook_not_configured' });
  const signature = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  if (!signature || !event.body) return jsonResponse(400, { success: false, error: 'invalid_webhook_request' });
  const api = new Stripe(awsEnv.stripeSecretKey, { apiVersion: '2026-06-24.dahlia' });
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = api.webhooks.constructEvent(Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'utf8'), signature, awsEnv.stripeConnectWebhookSecret);
  } catch (error) {
    return jsonResponse(error instanceof Stripe.errors.StripeSignatureVerificationError ? 400 : 500, { success: false, error: 'connect_webhook_verification_failed' });
  }
  if (!stripeEvent.account) return jsonResponse(400, { success: false, error: 'invalid_connect_event_scope' });
  if (!stripeEvent.livemode) return jsonResponse(200, { success: true, received: true, ignored: 'test_mode' });
  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        await fulfillAccountingInvoiceCheckout(stripeEvent.data.object as Stripe.Checkout.Session, api, stripeEvent.account);
        break;
      case 'charge.refunded':
        await flagAccountingInvoiceCharge(stripeEvent.data.object as Stripe.Charge, 'refund', api, stripeEvent.account);
        break;
      case 'charge.dispute.created': {
        const dispute = stripeEvent.data.object as Stripe.Dispute;
        const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
        if (chargeId) await flagAccountingInvoiceCharge(await api.charges.retrieve(chargeId, undefined, { stripeAccount: stripeEvent.account }), 'dispute', api, stripeEvent.account);
        break;
      }
      default:
        break;
    }
    return jsonResponse(200, { success: true, received: true });
  } catch (error) {
    console.error('Stripe Connect invoice event processing failed', { requestId: event.requestContext.requestId, eventId: stripeEvent.id, eventType: stripeEvent.type, message: error instanceof Error ? error.message : 'Unknown error' });
    return jsonResponse(500, { success: false, error: 'connect_invoice_event_failed' });
  }
}

export async function handler(event: APIGatewayProxyEventV2) {
  const path = event.rawPath ?? (event as APIGatewayProxyEventV2 & { path?: string }).path ?? '';
  if (path.endsWith('/accounting/stripe-connect/webhook')) return connectWebhook(event);
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
          if (await fulfillAccountingInvoiceCheckout(session, stripe)) break;
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
            await finishPaidContinuation(session, stripe);
          }
          break;
        }
        case 'checkout.session.async_payment_succeeded': {
          const session = stripeEvent.data.object as Stripe.Checkout.Session;
          if (await fulfillAccountingInvoiceCheckout(session, stripe)) break;
          if (isAccountingIntegrationUnlockSession(session)) {
            await fulfillAccountingIntegrationUnlock(session, stripe);
          } else {
            const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
            if (subscriptionId) {
              const subscription = await stripe.subscriptions.retrieve(subscriptionId);
              await syncStripeSubscription(subscription);
              await finishPaidContinuation(session, stripe);
            }
          }
          break;
        }
        case 'charge.refunded': {
          await flagAccountingInvoiceCharge(stripeEvent.data.object as Stripe.Charge, 'refund', stripe);
          break;
        }
        case 'charge.dispute.created': {
          const dispute = stripeEvent.data.object as Stripe.Dispute;
          const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
          if (chargeId) await flagAccountingInvoiceCharge(await stripe.charges.retrieve(chargeId), 'dispute', stripe);
          break;
        }
        case 'customer.subscription.created': {
          const subscription = stripeEvent.data.object as Stripe.Subscription;
          await syncStripeSubscription(subscription);
          await sendFreeTrialStartedNotification(subscription, stripe);
          break;
        }
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
      if (session?.metadata?.checkoutPurpose === 'accounting_invoice') {
        return jsonResponse(500, { success: false, error: 'accounting_invoice_payment_sync_failed', message: 'Stripe will retry invoice payment recording.' });
      }
      if (stripeEvent.type === 'charge.refunded' || stripeEvent.type === 'charge.dispute.created') {
        return jsonResponse(500, { success: false, error: 'accounting_invoice_payment_review_failed', message: 'Stripe will retry payment review recording.' });
      }
      if (session && isAccountingIntegrationUnlockSession(session)) {
        return jsonResponse(500, { success: false, error: 'accounting_integration_fulfillment_failed', message: 'Stripe will retry the accounting integration payment fulfilment.' });
      }
      if (session?.metadata?.checkoutPurpose === 'paid_continuation') {
        return jsonResponse(500, { success: false, error: 'paid_continuation_sync_failed', message: 'Stripe will retry the paid subscription reconciliation.' });
      }
      const trialSubscription = stripeEvent.type === 'customer.subscription.created'
        ? stripeEvent.data.object as Stripe.Subscription
        : null;
      if (trialSubscription?.status === 'trialing') {
        return jsonResponse(500, { success: false, error: 'free_trial_notification_failed', message: 'Stripe will retry the free-trial notification.' });
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
