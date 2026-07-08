import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { listExpenseClaims, listReceiptsByClaim } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const claimId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(claimId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_claim_id',
        message: 'A numeric claim id is required.',
      });
    }

    const claims = await listExpenseClaims(user, 200);
    const claim = claims.find((candidate) => candidate.id === claimId);
    if (!claim) {
      return jsonResponse(404, {
        success: false,
        error: 'claim_not_found',
        message: 'The claim could not be found.',
      });
    }

    const receipts = await listReceiptsByClaim(user, claimId);
    return jsonResponse(200, {
      success: true,
      claim,
      receipts,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'get_claim_failed';
    const message = error instanceof Error ? error.message : 'Could not load the claim.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
