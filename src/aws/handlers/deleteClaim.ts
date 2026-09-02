import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { deleteExpenseClaim } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const claimId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(claimId)) {
      return jsonResponse(400, { success: false, error: 'invalid_claim_id', message: 'A numeric claim id is required.' });
    }
    await deleteExpenseClaim(user, claimId);
    return jsonResponse(200, { success: true });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const message = error instanceof Error ? error.message : 'Could not delete the expense claim.';
    return jsonResponse(status, { success: false, error: 'delete_claim_failed', message });
  }
}
