import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { getPlanDefinition, getStripePriceId, isStripeConfigured, normalizeBillingCycle, normalizePlanId } from '../shared/billing.js';
import { awsEnv } from '../shared/env.js';
import { getOrganisationBillingSummary, getOrganisationName, updateOrganisationBillingProfile } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);

    if (!isStripeConfigured() || !awsEnv.stripeSecretKey) {
      return jsonResponse(503, {
        success: false,
        error: 'billing_not_configured',
        message: 'Online checkout is not available for this workspace yet. Contact hello@exdox.co.uk to change plans.',
      });
    }

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const planId = normalizePlanId(body.planId);
    const billingCycle = normalizeBillingCycle(body.billingCycle);
    const priceId = getStripePriceId(planId, billingCycle);
    if (!priceId) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_price_mapping',
        message: `Online checkout is not available yet for the ${getPlanDefinition(planId).label} ${billingCycle} plan. Contact hello@exdox.co.uk to change plans.`,
      });
    }

    const stripe = new Stripe(awsEnv.stripeSecretKey, {
      apiVersion: '2026-06-24.dahlia',
    });

    const billing = await getOrganisationBillingSummary(user.organisationId);
    const organisationName = await getOrganisationName(user.organisationId);
    let customerId = billing.stripeCustomerId;

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: organisationName,
        metadata: {
          organisationId: String(user.organisationId),
          planId,
        },
      });
      customerId = customer.id;
      await updateOrganisationBillingProfile({
        organisationId: user.organisationId,
        stripeCustomerId: customerId,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      success_url: awsEnv.stripeCheckoutSuccessUrl,
      cancel_url: awsEnv.stripeCheckoutCancelUrl,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        organisationId: String(user.organisationId),
        planId,
        billingCycle,
      },
      subscription_data: {
        metadata: {
          organisationId: String(user.organisationId),
          planId,
          billingCycle,
        },
      },
    });

    return jsonResponse(200, {
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'billing_checkout_failed';
    const message = error instanceof Error ? error.message : 'Could not start checkout.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
