import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { getOrganisationSettings } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const organisation = await getOrganisationSettings(user.organisationId);

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
      allowedWebRoutes:
        user.role === 'Business_Admin'
          ? ['/overview', '/costs', '/sales', '/claims', '/rules', '/reconciliation', '/settings', '/requisitions', '/bank-callback']
          : ['/dropbox'],
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
