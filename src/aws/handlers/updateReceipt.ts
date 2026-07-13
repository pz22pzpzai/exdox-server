import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { updateReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText, toNumber } from '../shared/helpers.js';

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

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const receipt = await updateReceiptById(user, receiptId, {
      vendorName: sanitizeText(body.vendorName) || null,
      invoiceDate: sanitizeText(body.invoiceDate) || null,
      dueDate: sanitizeText(body.dueDate) || null,
      invoiceNumber: sanitizeText(body.invoiceNumber) || null,
      category: sanitizeText(body.category) || null,
      description: sanitizeText(body.description) || null,
      customer: sanitizeText(body.customer) || null,
      netAmount: toNumber(body.netAmount),
      vatAmount: toNumber(body.vatAmount),
      totalAmount: toNumber(body.totalAmount),
      taxRateApplied: sanitizeText(body.taxRateApplied) || null,
      status: sanitizeText(body.status) as never,
    });

    return jsonResponse(200, {
      success: true,
      receipt,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'update_receipt_failed';
    const message = error instanceof Error ? error.message : 'Could not update the receipt.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
