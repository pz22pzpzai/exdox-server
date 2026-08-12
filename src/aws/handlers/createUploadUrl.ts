import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess, canProcessDocument, getPlanLimitMessage, isBillingActive } from '../shared/billing.js';
import { getOrganisationBillingSummary } from '../shared/db.js';
import { createReceiptUploadUrl } from '../shared/s3.js';
import { jsonResponse } from '../shared/http.js';
import { inferMimeType, parseWorkspaceContext, sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const body = event.body ? (JSON.parse(event.body) as Record<string, string | undefined>) : {};
    const fileName = sanitizeText(body.fileName) || `receipt-${Date.now()}.jpg`;
    const contentType = sanitizeText(body.contentType) || inferMimeType(fileName);
    const workspaceContext = parseWorkspaceContext(body.workspace_context);
    const billing = await getOrganisationBillingSummary(user.organisationId);

    if (!isBillingActive(billing)) {
      return jsonResponse(402, {
        success: false,
        error: 'billing_inactive',
        message: 'This workspace needs an active plan before new documents can be uploaded.',
      });
    }
    if (!canProcessDocument(billing)) {
      return jsonResponse(402, {
        success: false,
        error: 'plan_document_limit_reached',
        message: getPlanLimitMessage(billing, 'documents'),
      });
    }
    assertWorkspaceAccess(billing, workspaceContext);
    const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const datePrefix = new Date().toISOString().slice(0, 10);
    const key =
      workspaceContext === 'vault'
        ? `vault/org-${user.organisationId}/${datePrefix}/${Date.now()}-${safeFileName}`
        : `receipts/org-${user.organisationId}/${workspaceContext}/user-${user.id}/${datePrefix}/${Date.now()}-${safeFileName}`;

    const presigned = await createReceiptUploadUrl({
      key,
      contentType,
    });

    return jsonResponse(200, {
      success: true,
      workspaceContext,
      upload: presigned,
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'upload_url_failed';
    const message = error instanceof Error ? error.message : 'Could not create an upload URL.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
