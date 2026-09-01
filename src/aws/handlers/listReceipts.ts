import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess, canAccessWorkspace } from '../shared/billing.js';
import { getOrganisationBillingSummary, listReceipts } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean, parseWorkspaceContext } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const limit = Number(event.queryStringParameters?.limit ?? 50);
    const query = event.queryStringParameters ?? {};
    const claimId = query.claim_id ? Number(query.claim_id) : undefined;
    const billing = await getOrganisationBillingSummary(user.organisationId);
    const workspaceContext = typeof query.workspace_context === 'string' ? parseWorkspaceContext(query.workspace_context) : undefined;
    if (workspaceContext) {
      assertWorkspaceAccess(billing, workspaceContext);
    }

    const receipts = await listReceipts(user, {
      limit: Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50,
      workspaceContext,
      onlyClaimable: parseBoolean(query.only_claimable, false),
      claimId: Number.isFinite(claimId) ? claimId : undefined,
    });

    return jsonResponse(200, {
      success: true,
      receipts: workspaceContext ? receipts : receipts.filter((receipt) => canAccessWorkspace(billing, receipt.workspaceContext)),
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'list_receipts_failed';
    const message = error instanceof Error ? error.message : 'Could not load receipts.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
