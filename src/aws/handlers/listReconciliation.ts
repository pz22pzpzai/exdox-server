import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { assertFeatureAccess } from '../shared/billing.js';
import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { getOrganisationBillingSummary, listBankTransactionsWithCandidates } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);
    assertFeatureAccess(billing, 'reconciliation', 'Your current plan does not include bank reconciliation.');
    const lines = await listBankTransactionsWithCandidates(user.organisationId);

    return jsonResponse(200, {
      success: true,
      lines,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'list_reconciliation_failed';
    const message = error instanceof Error ? error.message : 'Could not load reconciliation lines.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
