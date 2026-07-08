import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { listExpenseClaims } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const limit = Number(event.queryStringParameters?.limit ?? 50);
    const claims = await listExpenseClaims(user, Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50);

    return jsonResponse(200, {
      success: true,
      claims,
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'list_claims_failed';
    const message = error instanceof Error ? error.message : 'Could not load expense claims.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
