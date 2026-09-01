import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import { deleteCompanyCard, getOrganisationBillingSummary } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    assertFeatureAccess(await getOrganisationBillingSummary(user.organisationId), 'supplier_rules', 'Your current plan does not include company card controls.');
    const cardId = Number(event.pathParameters?.id);
    if (!Number.isFinite(cardId)) {
      return jsonResponse(400, { success: false, error: 'invalid_company_card_id', message: 'A numeric company card id is required.' });
    }
    return jsonResponse(200, { success: true, result: await deleteCompanyCard(user.organisationId, cardId) });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'delete_company_card_failed', message: error instanceof Error ? error.message : 'Could not delete company card.' });
  }
}
