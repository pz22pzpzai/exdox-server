import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess, canAccessWorkspace } from '../shared/billing.js';
import { getOrganisationBillingSummary, listLegacyAdminDeletedReceiptDecisions, listReceipts, updateReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean, parseWorkspaceContext } from '../shared/helpers.js';
import { listDismissedReceiptDecisionIds, listReceiptDecisions, saveReceiptDecision } from '../shared/receiptDecisions.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const limit = Number(event.queryStringParameters?.limit ?? 50);
    const query = event.queryStringParameters ?? {};
    if (query.decisions_only === 'true') {
      const [recorded, legacy, dismissed] = await Promise.all([
        listReceiptDecisions(user.organisationId, user.id),
        listLegacyAdminDeletedReceiptDecisions(user),
        listDismissedReceiptDecisionIds(user.organisationId, user.id),
      ]);
      const visibleRecorded = recorded.filter((decision) => !dismissed.has(decision.receiptId));
      const recordedIds = new Set(recorded.map((decision) => decision.receiptId));
      const recovered = legacy.filter((decision) => !recordedIds.has(decision.receiptId) && !dismissed.has(decision.receiptId));
      await Promise.all(recovered.map(saveReceiptDecision));
      return jsonResponse(200, {
        success: true,
        decisions: [...visibleRecorded, ...recovered].sort((left, right) => right.decidedAt.localeCompare(left.decidedAt)),
      });
    }
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
      includeMileageCosts: parseBoolean(query.include_mileage_costs, false),
      claimId: Number.isFinite(claimId) ? claimId : undefined,
    });
    // Bring previously approved company-card costs into their already-paid state.
    // The update is idempotent, scoped to this admin's Costs list, and persists the correction.
    if (user.role === 'Business_Admin' && workspaceContext === 'cost' && !Number.isFinite(claimId) && !parseBoolean(query.only_claimable, false)) {
      for (const receipt of receipts) {
        if (receipt.paymentMethod === 'business_card' && receipt.status === 'Ready' && !receipt.needsReview && !receipt.mileageClaimId) {
          try {
            const paid = await updateReceiptById(user, receipt.id, { ...receipt, status: 'Paid' });
            Object.assign(receipt, paid);
          } catch (repairError) {
            console.error('Could not settle an approved company-card cost.', {
              receiptId: receipt.id,
              message: repairError instanceof Error ? repairError.message : 'Unknown error',
            });
          }
        }
      }
    }

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
