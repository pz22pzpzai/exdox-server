import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { updateClaimStatus } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

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

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const claim = await updateClaimStatus(user, claimId, sanitizeText(body.status) as never);

    return jsonResponse(200, {
      success: true,
      claim,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'update_claim_failed';
    const message = error instanceof Error ? error.message : 'Could not update the claim.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
