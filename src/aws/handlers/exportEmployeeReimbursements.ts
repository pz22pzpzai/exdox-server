import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserById, getOrganisationName, listReceipts } from '../shared/db.js';
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

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);

    const receipts = (await listReceipts(user, { workspaceContext: 'cost', limit: 1000 }))
      .filter((receipt) => receipt.paymentMethod === 'cash_personal')
      .filter((receipt) => receipt.status === 'Ready' && !receipt.needsReview);
    const employeeIds = [...new Set(receipts.map((receipt) => receipt.uploadedByUserId))];
    const employees = await Promise.all(employeeIds.map((employeeId) => findUserById(user.organisationId, employeeId)));
    const activeEmployees = new Map(
      employees
        .filter((employee): employee is NonNullable<typeof employee> => Boolean(employee))
        .filter((employee) => employee.status === 'active')
        .map((employee) => [employee.id, employee]),
    );
    const summaries = new Map<number, EmployeeReimbursementSummary>();

    for (const receipt of receipts) {
      const employee = activeEmployees.get(receipt.uploadedByUserId);
      if (!employee) {
        continue;
      }
      const current = summaries.get(employee.id) ?? {
        employeeId: employee.id,
        employeeName: employee.fullName || employee.email,
        employeeEmail: employee.email,
        approvedExpenseCount: 0,
        totalReimbursement: 0,
        currency: receipt.currency || 'GBP',
      };
      current.approvedExpenseCount += 1;
      current.totalReimbursement += receipt.totalAmount ?? receipt.netAmount ?? 0;
      summaries.set(employee.id, current);
    }

    const rows = [...summaries.values()].sort((left, right) => left.employeeName.localeCompare(right.employeeName));
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
      : 'employee_reimbursement_export_failed';
    const message = error instanceof Error ? error.message : 'Could not prepare the employee reimbursement payment summary.';
    return jsonResponse(status, { success: false, error: code, message });
  }
}
