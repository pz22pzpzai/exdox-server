import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess, assertWorkspaceAccess } from '../shared/billing.js';
import { getOrganisationBillingSummary, getReceiptById, updateReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText, toNumber } from '../shared/helpers.js';
import { getHistoricalExchangeRate } from '../shared/exchangeRates.js';

const ukVatTreatments = new Set([
  'not_applicable',
  'no_uk_vat_to_reclaim',
  'uk_vat_included',
  'reverse_charge_required',
  'import_vat',
  'accountant_review',
]);

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const receiptId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(receiptId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_receipt_id',
        message: 'A numeric receipt id is required.',
      });
    }

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const [billing, existingReceipt] = await Promise.all([
      getOrganisationBillingSummary(user.organisationId),
      getReceiptById(user, receiptId),
    ]);
    assertWorkspaceAccess(billing, existingReceipt.workspaceContext);
    const requestedStatus = sanitizeText(body.status);
    if (
      requestedStatus !== existingReceipt.status
      && ['Ready', 'Published'].includes(requestedStatus)
      && existingReceipt.workspaceContext !== 'vault'
    ) {
      assertFeatureAccess(
        billing,
        'approval_workflows',
        'Your current plan does not include approval workflows. Upgrade to Control or Operations to approve documents.',
      );
    }
    const hasTaxTreatmentUpdate = ['foreignTaxAmount', 'foreignTaxLabel', 'ukVatTreatment'].some((key) => Object.prototype.hasOwnProperty.call(body, key));
    if (hasTaxTreatmentUpdate) {
      requireAdminUser(user);
    }
    const requestedUkVatTreatment = sanitizeText(body.ukVatTreatment);
    if (requestedUkVatTreatment && !ukVatTreatments.has(requestedUkVatTreatment)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_uk_vat_treatment',
        message: 'Select a valid UK VAT treatment.',
      });
    }
    const requestedRate = toNumber(body.exchangeRate);
    const sourceCurrency = sanitizeText(body.currency || existingReceipt.currency || 'GBP').toUpperCase();
    const baseCurrency = sanitizeText(body.baseCurrency || existingReceipt.baseCurrency || 'GBP').toUpperCase();
    if (requestedRate !== null && requestedRate <= 0) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_exchange_rate',
        message: 'The exchange rate must be greater than zero.',
      });
    }
    const useManualSettlementRate =
      (body.exchangeRateOverride === true || body.exchangeRateProvider === 'manual_settlement') &&
      requestedRate !== null &&
      sourceCurrency !== baseCurrency;
    if (useManualSettlementRate) {
      requireAdminUser(user);
    }
    const currencyChanged = sourceCurrency !== (existingReceipt.currency ?? existingReceipt.baseCurrency ?? 'GBP').toUpperCase();
    const automaticExchangeRate =
      !useManualSettlementRate && sourceCurrency === baseCurrency && currencyChanged
        ? { rate: 1, rateDate: sanitizeText(body.invoiceDate) || existingReceipt.invoiceDate || new Date().toISOString().slice(0, 10), provider: 'same_currency' as const }
        : !useManualSettlementRate && sourceCurrency !== baseCurrency && (currencyChanged || existingReceipt.exchangeRate === null)
          ? await getHistoricalExchangeRate({
              fromCurrency: sourceCurrency,
              toCurrency: baseCurrency,
              documentDate: sanitizeText(body.invoiceDate) || existingReceipt.invoiceDate,
            })
          : null;
    if (currencyChanged && sourceCurrency !== baseCurrency && !automaticExchangeRate && !useManualSettlementRate) {
      return jsonResponse(502, {
        success: false,
        error: 'exchange_rate_unavailable',
        message: 'Could not retrieve the historical exchange rate. Please try saving again.',
      });
    }
    const grossTotal = toNumber(body.totalAmount) ?? existingReceipt.totalAmount;
    const effectiveRate = useManualSettlementRate
      ? requestedRate
      : automaticExchangeRate?.rate ?? existingReceipt.exchangeRate;
    const baseTotalAmount =
      grossTotal === null
        ? null
        : sourceCurrency === baseCurrency
          ? grossTotal
          : effectiveRate === null
            ? existingReceipt.baseTotalAmount
            : Number((grossTotal * effectiveRate).toFixed(2));
    const receipt = await updateReceiptById(user, receiptId, {
      vendorName: sanitizeText(body.vendorName) || null,
      invoiceDate: sanitizeText(body.invoiceDate) || null,
      dueDate: sanitizeText(body.dueDate) || null,
      invoiceNumber: sanitizeText(body.invoiceNumber) || null,
      category: sanitizeText(body.category) || null,
      description: sanitizeText(body.description) || null,
      customer: sanitizeText(body.customer) || null,
      currency: sourceCurrency,
      netAmount: toNumber(body.netAmount),
      vatAmount: toNumber(body.vatAmount),
      totalAmount: toNumber(body.totalAmount),
      taxRateApplied: sanitizeText(body.taxRateApplied) || null,
      status: sanitizeText(body.status) as never,
      baseCurrency,
      exchangeRate: useManualSettlementRate ? requestedRate : automaticExchangeRate?.rate ?? existingReceipt.exchangeRate,
      exchangeRateDate: useManualSettlementRate
        ? sanitizeText(body.exchangeRateDate) || existingReceipt.invoiceDate || new Date().toISOString().slice(0, 10)
        : automaticExchangeRate?.rateDate ?? existingReceipt.exchangeRateDate,
      exchangeRateProvider: useManualSettlementRate
        ? 'manual_settlement'
        : automaticExchangeRate?.provider ?? existingReceipt.exchangeRateProvider,
      baseTotalAmount,
      exchangeRateOverride: useManualSettlementRate,
      exchangeRateNote: useManualSettlementRate
        ? sanitizeText(body.exchangeRateNote) || 'Manual settlement rate supplied by a business admin.'
        : existingReceipt.exchangeRateNote,
      foreignTaxAmount: Object.prototype.hasOwnProperty.call(body, 'foreignTaxAmount')
        ? toNumber(body.foreignTaxAmount)
        : existingReceipt.foreignTaxAmount,
      foreignTaxLabel: Object.prototype.hasOwnProperty.call(body, 'foreignTaxLabel')
        ? sanitizeText(body.foreignTaxLabel) || null
        : existingReceipt.foreignTaxLabel,
      ukVatTreatment: requestedUkVatTreatment as typeof existingReceipt.ukVatTreatment || existingReceipt.ukVatTreatment,
    });

    return jsonResponse(200, {
      success: true,
      receipt,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'update_receipt_failed';
    const message = error instanceof Error ? error.message : 'Could not update the receipt.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
