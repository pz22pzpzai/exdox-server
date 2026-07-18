import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { isStripeConfigured } from '../shared/billing.js';
import { awsEnv } from '../shared/env.js';
import { getOrganisationBillingSummary } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);

    if (!isStripeConfigured() || !awsEnv.stripeSecretKey) {
      return jsonResponse(503, {
        success: false,
        error: 'billing_not_configured',
        message: 'The billing portal is not available for this workspace yet. Contact hello@exdox.co.uk if you need billing support.',
      });
    }

    const billing = await getOrganisationBillingSummary(user.organisationId);
    if (!billing.stripeCustomerId) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_customer',
        message: 'This workspace does not have a billing portal profile yet. Contact hello@exdox.co.uk if you need billing support.',
      });
    }

    const stripe = new Stripe(awsEnv.stripeSecretKey, {
      apiVersion: '2026-06-24.dahlia',
    });

    const session = await stripe.billingPortal.sessions.create({
      customer: billing.stripeCustomerId,
      return_url: awsEnv.stripeBillingPortalReturnUrl,
    });

    return jsonResponse(200, {
      success: true,
      portalUrl: session.url,
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'billing_portal_failed';
    const message = error instanceof Error ? error.message : 'Could not open the billing portal.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
