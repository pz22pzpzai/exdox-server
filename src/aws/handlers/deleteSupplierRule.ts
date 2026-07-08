import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { deleteSupplierRule } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const ruleId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(ruleId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_rule_id',
        message: 'A numeric supplier rule id is required.',
      });
    }

    const result = await deleteSupplierRule(user.organisationId, ruleId);
    return jsonResponse(200, {
      success: true,
      result,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'delete_supplier_rule_failed';
    const message = error instanceof Error ? error.message : 'Could not delete supplier rule.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
