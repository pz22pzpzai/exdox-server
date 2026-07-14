import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { buildEntitlements, isStripeConfigured, resolveAllowedWebRoutes } from '../shared/billing.js';
import { getOrganisationBillingSummary, getOrganisationSettings } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const organisation = await getOrganisationSettings(user.organisationId);
    const billing = await getOrganisationBillingSummary(user.organisationId);
    const allowedWebRoutes = resolveAllowedWebRoutes(billing, user.role);

    return jsonResponse(200, {
      success: true,
      user,
      organisations: [
        {
          id: organisation.organisationId,
          name: organisation.organisationName,
        },
      ],
      activeOrganisationId: organisation.organisationId,
      allowedWebRoutes,
      billing: {
        ...billing,
        planLabel: billing.planId === 'legacy' ? 'Legacy' : billing.planId[0]!.toUpperCase() + billing.planId.slice(1),
        stripeConfigured: isStripeConfigured(),
      },
      entitlements: buildEntitlements(billing),
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'session_failed';
    const message = error instanceof Error ? error.message : 'Could not load session.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
