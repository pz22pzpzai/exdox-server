import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { buildEntitlements, isStripeConfigured, listPlanDefinitions } from '../shared/billing.js';
import { getOrganisationBillingSummary } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);

    return jsonResponse(200, {
      success: true,
      billing: {
        ...billing,
        stripeConfigured: isStripeConfigured(),
      },
      entitlements: buildEntitlements(billing),
      plans: listPlanDefinitions(),
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'billing_load_failed';
    const message = error instanceof Error ? error.message : 'Could not load billing.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
