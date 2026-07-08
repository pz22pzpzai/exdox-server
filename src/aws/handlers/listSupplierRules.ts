import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { listSupplierRules } from '../shared/db.js';
import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const rules = await listSupplierRules(user.organisationId);

    return jsonResponse(200, {
      success: true,
      rules,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'list_supplier_rules_failed';
    const message = error instanceof Error ? error.message : 'Could not load supplier rules.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
