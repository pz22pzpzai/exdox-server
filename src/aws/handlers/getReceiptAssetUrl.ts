import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess } from '../shared/billing.js';
import { getOrganisationBillingSummary, getReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { createReceiptDownloadUrl } from '../shared/s3.js';

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
    const asset = await createReceiptDownloadUrl({
      key: receipt.s3Key,
    });

    return jsonResponse(200, {
      success: true,
      asset,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'asset_url_failed';
    const message = error instanceof Error ? error.message : 'Could not create the asset URL.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
