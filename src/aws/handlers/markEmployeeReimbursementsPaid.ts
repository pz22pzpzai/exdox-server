import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { updateReimbursementPaymentStatus } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const paidCount = await updateReimbursementPaymentStatus(user, 'Payment processing', 'Paid');
    return jsonResponse(200, { success: true, paidCount });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : 'reimbursement_payment_mark_failed';
    const message = error instanceof Error ? error.message : 'Could not mark the reimbursement payment batch as paid.';
    return jsonResponse(status, { success: false, error: code, message });
  }
}
