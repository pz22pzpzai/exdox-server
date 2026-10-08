import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import { getOrganisationBillingSummary, upsertSupplierRule } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean, parsePaymentMethod, sanitizeText } from '../shared/helpers.js';
import { validateLineItemGroups, validateSplitRule, type GroupMode, type LineItemGroup, type SplitMode, type SplitPart } from '../shared/documentAutomation.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);
    assertFeatureAccess(billing, 'supplier_rules', 'Your current plan does not include supplier rules.');
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const workspaceContext = body.workspaceContext === 'sales' ? 'sales' : 'cost';
    const splitMode: SplitMode = body.splitMode === 'percentage' || body.splitMode === 'fixed' ? body.splitMode : 'none';
    const splitAllocations: SplitPart[] = Array.isArray(body.splitAllocations)
      ? body.splitAllocations.map((part: unknown) => ({
        category: sanitizeText((part as Record<string, unknown>)?.category),
        value: Number((part as Record<string, unknown>)?.value),
      })) : [];
    try { validateSplitRule(splitMode, splitAllocations); }
    catch (error) { return jsonResponse(400, { success: false, error: 'invalid_split_rule', message: error instanceof Error ? error.message : 'Invalid split rule.' }); }
    const lineItemGroupMode: GroupMode = ['description', 'tax'].includes(String(body.lineItemGroupMode))
      ? body.lineItemGroupMode as GroupMode : 'none';
    const lineItemGroups: LineItemGroup[] = Array.isArray(body.lineItemGroups)
      ? body.lineItemGroups.map((group: unknown) => ({
        name: sanitizeText((group as Record<string, unknown>)?.name),
        matchText: sanitizeText((group as Record<string, unknown>)?.matchText),
        category: sanitizeText((group as Record<string, unknown>)?.category),
      })) : [];
    try {
      validateLineItemGroups(lineItemGroupMode, lineItemGroups);
      if (splitMode !== 'none' && lineItemGroupMode !== 'none') throw new Error('Choose Smart Split or line-item grouping for this rule, not both.');
    } catch (error) { return jsonResponse(400, { success: false, error: 'invalid_line_item_group', message: error instanceof Error ? error.message : 'Invalid line-item group.' }); }

    const rule = await upsertSupplierRule({
      id: Number.isFinite(Number(body.id)) ? Number(body.id) : undefined,
      organisationId: user.organisationId,
      workspaceContext,
      supplierMatchText: sanitizeText(body.supplierMatchText),
      category: sanitizeText(body.category),
      taxRate: sanitizeText(body.taxRate) || '20% Standard',
      paymentMethod: parsePaymentMethod(body.paymentMethod, 'business_card'),
      isActive: parseBoolean(String(body.isActive ?? 'true'), true),
      splitMode,
      splitAllocations,
      lineItemGroupMode,
      lineItemGroups,
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
