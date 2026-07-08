import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { createExpenseClaim } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const body = event.body ? (JSON.parse(event.body) as Record<string, string | undefined>) : {};
    const claim = await createExpenseClaim({
      organisationId: user.organisationId,
      createdByUserId: user.id,
      name: sanitizeText(body.name) || `Expense Claim ${new Date().toISOString().slice(0, 10)}`,
      description: sanitizeText(body.description) || null,
      currency: sanitizeText(body.currency) || 'GBP',
    });

    return jsonResponse(200, {
      success: true,
      claim,
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'create_claim_failed';
    const message = error instanceof Error ? error.message : 'Could not create the expense claim.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
