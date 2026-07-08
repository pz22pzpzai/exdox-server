import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createBankRequisition } from '../shared/db.js';
import { awsEnv } from '../shared/env.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};

    const requisition = await createBankRequisition({
      organisationId: user.organisationId,
      provider: sanitizeText(body.provider) || awsEnv.openBankingProvider,
      institutionId: sanitizeText(body.institutionId) || null,
    });

    return jsonResponse(201, {
      success: true,
      requisition,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'create_requisition_failed';
    const message = error instanceof Error ? error.message : 'Could not create bank requisition.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
