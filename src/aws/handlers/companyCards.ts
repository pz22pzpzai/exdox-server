import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import {
  getOrganisationBillingSummary,
  listCompanyCardEmployeeExceptions,
  listCompanyCards,
  upsertCompanyCard,
} from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean, sanitizeText } from '../shared/helpers.js';

export async function listHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    assertFeatureAccess(await getOrganisationBillingSummary(user.organisationId), 'supplier_rules', 'Your current plan does not include company card controls.');
    const [cards, exceptions] = await Promise.all([
      listCompanyCards(user.organisationId),
      listCompanyCardEmployeeExceptions(user.organisationId),
    ]);
    return jsonResponse(200, { success: true, cards, exceptions });
  } catch (error) {
    return companyCardError(error, 'Could not load company cards.');
  }
}

export async function upsertHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    assertFeatureAccess(await getOrganisationBillingSummary(user.organisationId), 'supplier_rules', 'Your current plan does not include company card controls.');
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const card = await upsertCompanyCard({
      id: Number.isFinite(Number(body.id)) ? Number(body.id) : undefined,
      organisationId: user.organisationId,
      label: sanitizeText(body.label),
      cardNetwork: sanitizeText(body.cardNetwork) || null,
      cardIssuer: sanitizeText(body.cardIssuer) || null,
      lastFour: sanitizeText(body.lastFour),
      isActive: parseBoolean(String(body.isActive ?? 'true'), true),
    });
    return jsonResponse(200, { success: true, card });
  } catch (error) {
    return companyCardError(error, 'Could not save company card.');
  }
}

function companyCardError(error: unknown, fallbackMessage: string) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  return jsonResponse(status, {
    success: false,
    error: 'company_card_request_failed',
    message: error instanceof Error ? error.message : fallbackMessage,
  });
}
