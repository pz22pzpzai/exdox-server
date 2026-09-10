import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createAccountingIntegrationUnlockCheckout } from '../shared/accountingIntegrationUnlock.js';
import { isOrganisationOwner } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    if (!(await isOrganisationOwner(user))) {
      return jsonResponse(403, { success: false, error: 'owner_access_required', message: 'Only the business owner can make the accounting integration payment.' });
    }
    return jsonResponse(200, { success: true, ...(await createAccountingIntegrationUnlockCheckout(user)) });
  } catch (error) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'accounting_integration_checkout_failed';
    return jsonResponse(statusCode, { success: false, error: code, message: error instanceof Error ? error.message : 'Could not start the accounting integration payment.' });
  }
}
