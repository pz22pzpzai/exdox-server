import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import { getOrganisationBillingSummary, updateReimbursementPaymentStatus } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);
    assertFeatureAccess(
      billing,
      'queue_exports',
      'Your current plan does not include reimbursement payment management. Upgrade to Control or Operations to continue.',
    );
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
