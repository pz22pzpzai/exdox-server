import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser, signUserToken } from '../shared/auth.js';
import { buildEntitlements, isStripeConfigured, resolveAllowedWebRoutes } from '../shared/billing.js';
import { findUserByEmail, getOrganisationBillingSummary, getOrganisationSettings } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { hydrateBillingSummaryFromStripe } from '../shared/stripeBilling.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const tokenUser = requireAuthenticatedUser(event);
    let user = tokenUser;
    let refreshedToken: string | null = null;

    if (tokenUser.status === 'pending_confirmation') {
      const storedUser = await findUserByEmail(tokenUser.email);
      if (
        storedUser
        && storedUser.id === tokenUser.id
        && storedUser.organisationId === tokenUser.organisationId
        && storedUser.status === 'active'
      ) {
        user = {
          id: storedUser.id,
          organisationId: storedUser.organisationId,
          email: storedUser.email,
          fullName: storedUser.fullName,
          role: storedUser.role,
          status: 'active',
          emailConfirmationDueAt: null,
        };
        refreshedToken = signUserToken(user);
      }
    }

    const organisation = await getOrganisationSettings(user.organisationId);
    const billing = await hydrateBillingSummaryFromStripe(await getOrganisationBillingSummary(user.organisationId));
    const allowedWebRoutes = resolveAllowedWebRoutes(billing, user.role);

    return jsonResponse(200, {
      success: true,
      token: refreshedToken,
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
