import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess } from '../shared/billing.js';
import { deleteReceiptById, getOrganisationBillingSummary, getReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const receiptId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(receiptId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_receipt_id',
        message: 'A numeric receipt id is required.',
      });
    }

    const [billing, receipt] = await Promise.all([
      getOrganisationBillingSummary(user.organisationId),
      getReceiptById(user, receiptId),
    ]);
    assertWorkspaceAccess(billing, receipt.workspaceContext);
    const result = await deleteReceiptById(user, receiptId);
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
        : 'delete_receipt_failed';
    const message = error instanceof Error ? error.message : 'Could not delete the receipt.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
