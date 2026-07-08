import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { upsertSupplierRule } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean, parsePaymentMethod, sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};

    const rule = await upsertSupplierRule({
      id: Number.isFinite(Number(body.id)) ? Number(body.id) : undefined,
      organisationId: user.organisationId,
      supplierMatchText: sanitizeText(body.supplierMatchText),
      category: sanitizeText(body.category),
      taxRate: sanitizeText(body.taxRate) || '20% Standard',
      paymentMethod: parsePaymentMethod(body.paymentMethod, 'business_card'),
      isActive: parseBoolean(String(body.isActive ?? 'true'), true),
    });

    return jsonResponse(200, {
      success: true,
      rule,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'upsert_supplier_rule_failed';
    const message = error instanceof Error ? error.message : 'Could not save supplier rule.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
