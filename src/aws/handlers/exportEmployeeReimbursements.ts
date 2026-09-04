import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { randomUUID } from 'node:crypto';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import { findUserById, getOrganisationBillingSummary, getOrganisationName, listReceipts, updateReimbursementPaymentStatus } from '../shared/db.js';
import { sendEmployeeReimbursementReadyEmail } from '../shared/expenseExportMail.js';
import { jsonResponse } from '../shared/http.js';

type EmployeeReimbursementSummary = {
  employeeId: number;
  employeeName: string;
  employeeEmail: string;
  approvedExpenseCount: number;
  totalReimbursement: number;
  currency: string;
};

type ReimbursementRecipient = {
  id: number;
  fullName: string | null;
  email: string;
};

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);
    assertFeatureAccess(
      billing,
      'queue_exports',
      'Your current plan does not include reimbursement exports.',
    );

    const receipts = (await listReceipts(user, { workspaceContext: 'cost', includeMileageCosts: true, limit: 50000 }))
      .filter((receipt) => receipt.paymentMethod === 'cash_personal')
      .filter((receipt) => receipt.status === 'Ready' && !receipt.needsReview);
    if (!receipts.length) {
      throw reimbursementExportError(
        'No approved personal-spend expenses are ready for reimbursement. Select Personal spend before approval, then approve the expense before creating a payment summary.',
      );
    }

    const employeeIds = [...new Set(receipts.map((receipt) => receipt.uploadedByUserId))];
    const employees = await Promise.all(employeeIds.map((employeeId) => findUserById(user.organisationId, employeeId)));
    const reimbursementRecipients = new Map<number, ReimbursementRecipient>(
      employees
        .filter((employee): employee is NonNullable<typeof employee> => Boolean(employee))
        .map((employee) => [employee.id, {
          id: employee.id,
          fullName: employee.fullName,
          email: employee.email,
        }]),
    );

    // The business owner can submit their own personal expenses. Use the authenticated
    // session as a fallback so a sole trader is always included in their payment summary.
    if (!reimbursementRecipients.has(user.id)) {
      reimbursementRecipients.set(user.id, {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
      });
    }

    const summaries = new Map<number, EmployeeReimbursementSummary>();
    const includedReceiptIds: number[] = [];

    for (const receipt of receipts) {
      const employee = reimbursementRecipients.get(receipt.uploadedByUserId);
      if (!employee) {
        continue;
      }
      const current = summaries.get(employee.id) ?? {
        employeeId: employee.id,
        employeeName: employee.fullName || employee.email,
        employeeEmail: employee.email,
        approvedExpenseCount: 0,
        totalReimbursement: 0,
        currency: receipt.baseCurrency || 'GBP',
      };
      current.approvedExpenseCount += 1;
      current.totalReimbursement += receipt.baseTotalAmount ?? receipt.totalAmount ?? receipt.netAmount ?? 0;
      summaries.set(employee.id, current);
      includedReceiptIds.push(receipt.id);
    }

    const rows = [...summaries.values()].sort((left, right) => left.employeeName.localeCompare(right.employeeName));
    if (!rows.length) {
      throw reimbursementExportError(
        'No approved personal-spend expenses belong to a workspace user. Check the receipt owner before creating a payment summary.',
      );
    }

    const organisationName = await getOrganisationName(user.organisationId);
    const exportedAt = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      timeZone: 'Europe/London',
    });
    const deliveries = await Promise.allSettled(rows.map((row) => sendEmployeeReimbursementReadyEmail({
      toEmail: row.employeeEmail,
      fullName: row.employeeName,
      organisationName,
      exportedAt,
    })));
    const paymentProcessingCount = await updateReimbursementPaymentStatus(user, 'Ready', 'Payment processing', {
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    }, includedReceiptIds);

    return jsonResponse(200, {
      success: true,
      organisationName,
      exportedAt,
      rows,
      notifications: {
        sent: deliveries.filter((result) => result.status === 'fulfilled').length,
        failed: deliveries.filter((result) => result.status === 'rejected').length,
      },
      paymentProcessingCount,
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : 'employee_reimbursement_export_failed';
    const message = error instanceof Error ? error.message : 'Could not prepare the employee reimbursement payment summary.';
    return jsonResponse(status, { success: false, error: code, message });
  }
}

function reimbursementExportError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = 'no_reimbursements_ready';
  return error;
}
