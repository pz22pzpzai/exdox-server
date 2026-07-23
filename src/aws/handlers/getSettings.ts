import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { getOrganisationSettings } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const settings = await getOrganisationSettings(user.organisationId);

    return jsonResponse(200, {
      success: true,
      settings,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'get_settings_failed';
    const message = error instanceof Error ? error.message : 'Could not load settings.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
