import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { updateOrganisationSettings } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean, sanitizeText } from '../shared/helpers.js';
import { workspaceCountry } from '../shared/workspaceCountry.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const country = workspaceCountry(body.country);
    if (body.country != null && country !== body.country) {
      return jsonResponse(400, { success: false, error: 'invalid_country', message: 'Choose a supported country.' });
    }
    const settings = await updateOrganisationSettings({
      organisationId: user.organisationId,
      country: body.country == null ? undefined : country,
      baseCurrency: sanitizeText(body.baseCurrency) || undefined,
      isVatRegistered: parseBoolean(String(body.isVatRegistered ?? 'false'), false),
      defaultTaxRate: sanitizeText(body.defaultTaxRate) || 'No VAT',
      mileageRate: Number(body.mileageRate),
    });

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
        : 'update_settings_failed';
    const message = error instanceof Error ? error.message : 'Could not update settings.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
