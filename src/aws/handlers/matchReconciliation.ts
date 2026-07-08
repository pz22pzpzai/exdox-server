import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { matchBankTransaction } from '../shared/db.js';
import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const bankTransactionId = Number(body.bankTransactionId ?? body.statementLineId);
    const receiptId = Number(body.receiptId);
    if (!Number.isFinite(bankTransactionId) || !Number.isFinite(receiptId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_reconciliation_ids',
        message: 'Both bankTransactionId and receiptId are required.',
      });
    }

    const result = await matchBankTransaction({
      organisationId: user.organisationId,
      bankTransactionId,
      receiptId,
    });

    return jsonResponse(200, {
      success: true,
      result,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'match_reconciliation_failed';
    const message = error instanceof Error ? error.message : 'Could not match the statement line.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
