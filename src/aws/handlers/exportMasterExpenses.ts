import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import { findUserById, getOrganisationBaseCurrency, getOrganisationBillingSummary, getOrganisationName, listExpenseClaims, listReceipts } from '../shared/db.js';
import { sendExpenseExportSummaryEmail } from '../shared/expenseExportMail.js';
import { jsonResponse } from '../shared/http.js';

type EmployeeSummary = {
  employeeId: number;
  employeeName: string;
  employeeEmail: string;
  approvedClaimCount: number;
  approvedDocumentCount: number;
  totalAmount: number;
  currency: string;
};

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);
    assertFeatureAccess(
      billing,
      'queue_exports',
      'Your current plan does not include master expense exports. Upgrade to Control or Operations to create accountant summaries.',
    );
    const body = event.body ? (JSON.parse(event.body) as { employeeIds?: unknown }) : {};
    const selectedEmployeeIds = Array.isArray(body.employeeIds)
      ? new Set(body.employeeIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))
      : null;
    const approvedClaims = (await listExpenseClaims(user, 500))
      .filter((claim) => claim.status === 'approved' || claim.status === 'paid')
      .filter((claim) => !selectedEmployeeIds || selectedEmployeeIds.has(claim.createdByUserId));
    const [baseCurrency, costReceipts] = await Promise.all([
      getOrganisationBaseCurrency(user.organisationId),
      listReceipts(user, { workspaceContext: 'cost', limit: 50000 }),
    ]);
    const summaries = new Map<number, EmployeeSummary>();

    for (const claim of approvedClaims) {
      const claimant = await findUserById(user.organisationId, claim.createdByUserId);
      if (!claimant || claimant.role !== 'Standard_Employee' || claimant.status !== 'active') {
        continue;
      }
      const current = summaries.get(claimant.id) ?? {
        employeeId: claimant.id,
        employeeName: claimant.fullName || claimant.email,
        employeeEmail: claimant.email,
        approvedClaimCount: 0,
        approvedDocumentCount: 0,
        totalAmount: 0,
        currency: baseCurrency,
      };
      const attachedReceipts = costReceipts.filter((receipt) => receipt.claimId === claim.id);
      current.approvedClaimCount += 1;
      current.approvedDocumentCount += attachedReceipts.length;
      current.totalAmount += attachedReceipts.reduce(
        (total, receipt) => total + (receipt.baseTotalAmount ?? receipt.totalAmount ?? 0),
        0,
      );
      summaries.set(claimant.id, current);
    }

    const rows = [...summaries.values()].sort((left, right) => left.employeeName.localeCompare(right.employeeName));
    const organisationName = await getOrganisationName(user.organisationId);
    const exportedAt = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Europe/London',
    });
    const deliveries = await Promise.allSettled(rows.map((row) => sendExpenseExportSummaryEmail({
      toEmail: row.employeeEmail,
      fullName: row.employeeName,
      organisationName,
      approvedClaimCount: row.approvedClaimCount,
      approvedDocumentCount: row.approvedDocumentCount,
      totalAmount: row.totalAmount,
      currency: row.currency,
      exportedAt,
    })));

    return jsonResponse(200, {
      success: true,
      organisationName,
      exportedAt,
      rows,
      notifications: {
        sent: deliveries.filter((result) => result.status === 'fulfilled').length,
        failed: deliveries.filter((result) => result.status === 'rejected').length,
      },
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : 'master_expense_export_failed';
    const message = error instanceof Error ? error.message : 'Could not prepare the master expense export.';
    return jsonResponse(status, { success: false, error: code, message });
  }
}
