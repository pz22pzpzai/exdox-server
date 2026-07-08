import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { attachReceiptToClaim } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const body = event.body ? (JSON.parse(event.body) as Record<string, number | string | undefined>) : {};
    const receiptId = Number(body.receiptId);
    const claimId = Number(body.claimId);

    if (!Number.isFinite(receiptId) || !Number.isFinite(claimId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_payload',
        message: 'Provide numeric receiptId and claimId values.',
      });
    }

    const receipt = await attachReceiptToClaim({
      user,
      receiptId,
      claimId,
    });

    return jsonResponse(200, {
      success: true,
      receipt,
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'attach_receipt_failed';
    const message = error instanceof Error ? error.message : 'Could not attach the receipt to the expense claim.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
