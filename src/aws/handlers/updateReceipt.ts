import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess, assertWorkspaceAccess } from '../shared/billing.js';
import { getOrganisationBillingSummary, getReceiptById, updateReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { canChangeSalesStatus, isSalesStatus } from '../shared/salesWorkflow.js';
import { parsePaymentMethod, sanitizeText, toNumber } from '../shared/helpers.js';
import { getHistoricalExchangeRate } from '../shared/exchangeRates.js';
import { decisionFromReceipt, deleteReceiptDecision, getReceiptDecision, saveReceiptDecision } from '../shared/receiptDecisions.js';
import { autoPublishApprovedReceiptToXero } from './xero.js';

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
    if (existingReceipt.workspaceContext === 'cost' && requestedStatus === 'Rejected' && existingReceipt.status !== 'Rejected') {
      requireAdminUser(user);
      if (existingReceipt.status !== 'Review' || existingReceipt.claimId !== null) {
        return jsonResponse(409, {
          success: false,
          error: 'receipt_not_unreviewed',
          message: 'Only an unreviewed purchase that is not attached to a claim can be rejected.',
        });
      }
    }
    if (existingReceipt.workspaceContext === 'cost' && existingReceipt.status === 'Rejected' && user.role !== 'Business_Admin') {
      return jsonResponse(403, { success: false, error: 'rejected_receipt_locked', message: 'This rejected purchase can only be deleted by its uploader.' });
    }
    if (
      existingReceipt.workspaceContext === 'sales'
      && requestedStatus
      && !canChangeSalesStatus(user.role, existingReceipt.status, requestedStatus)
    ) {
      return jsonResponse(403, {
        success: false,
        error: 'sales_workflow_admin_required',
        message: 'Only a business admin can approve or publish a sales document.',
      });
    }
    if (
      existingReceipt.workspaceContext === 'sales'
      && requestedStatus
      && !isSalesStatus(requestedStatus)
    ) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_sales_status',
        message: 'Choose Processing, Review, Ready, Published, Paid, or Rejected for a sales document.',
      });
    }
    if (
      requestedStatus !== existingReceipt.status
      && ['Ready', 'Published'].includes(requestedStatus)
      && existingReceipt.workspaceContext !== 'vault'
    ) {
      assertFeatureAccess(
        billing,
        'approval_workflows',
        'Your current plan does not include approval workflows.',
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
    const notifyRejection = existingReceipt.workspaceContext === 'cost'
      && requestedStatus === 'Rejected'
      && existingReceipt.status !== 'Rejected'
      && existingReceipt.uploadedByUserId !== user.id;
    const previousDecision = notifyRejection
      ? await getReceiptDecision(user.organisationId, existingReceipt.uploadedByUserId, receiptId)
      : null;
    if (notifyRejection) await saveReceiptDecision(decisionFromReceipt({
      ...existingReceipt,
      vendorName: sanitizeText(body.vendorName) || existingReceipt.vendorName,
      totalAmount: grossTotal,
      currency: sourceCurrency,
    }, 'rejected'));
    let receipt;
    try {
      const allocationLines = Array.isArray(body.allocationLines)
        ? body.allocationLines.map((line: unknown) => ({
          category: sanitizeText((line as Record<string, unknown>)?.category),
          netAmount: Number((line as Record<string, unknown>)?.netAmount),
          description: sanitizeText((line as Record<string, unknown>)?.description) || undefined,
          taxRateApplied: sanitizeText((line as Record<string, unknown>)?.taxRateApplied) || null,
        })) : existingReceipt.allocationLines ?? [];
      if (allocationLines.length > 20 || allocationLines.some((line) => !line.category || !Number.isFinite(line.netAmount) || line.netAmount <= 0)) {
        return jsonResponse(400, { success: false, error: 'invalid_split', message: 'Split allocations need a category and positive net amount.' });
      }
      receipt = await updateReceiptById(user, receiptId, {
      allocationLines,
      vendorName: sanitizeText(body.vendorName) || null,
      invoiceDate: sanitizeText(body.invoiceDate) || null,
      dueDate: sanitizeText(body.dueDate) || null,
      invoiceNumber: sanitizeText(body.invoiceNumber) || null,
      category: sanitizeText(body.category) || null,
      description: sanitizeText(body.description) || null,
      customer: sanitizeText(body.customer) || null,
      paymentMethod: parsePaymentMethod(body.paymentMethod, existingReceipt.paymentMethod),
      currency: sourceCurrency,
      netAmount: toNumber(body.netAmount),
      vatAmount: toNumber(body.vatAmount),
      totalAmount: toNumber(body.totalAmount),
      taxRateApplied: sanitizeText(body.taxRateApplied) || null,
      status: (requestedStatus || existingReceipt.status) as typeof existingReceipt.status,
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
    } catch (error) {
      if (notifyRejection) {
        if (previousDecision) await saveReceiptDecision(previousDecision);
        else await deleteReceiptDecision(user.organisationId, existingReceipt.uploadedByUserId, receiptId);
      }
      throw error;
    }
    if (existingReceipt.status === 'Rejected' && receipt.status !== 'Rejected') {
      await deleteReceiptDecision(user.organisationId, existingReceipt.uploadedByUserId, receiptId);
    }

    let warning: string | null = null;
    if (
      user.role === 'Business_Admin'
      && existingReceipt.status === 'Review'
      && receipt.status === 'Ready'
      && receipt.workspaceContext !== 'vault'
      && receipt.claimId === null
    ) {
      try {
        const published = await autoPublishApprovedReceiptToXero(user, receipt.id);
        if (published) {
          receipt = await getReceiptById(user, receipt.id);
          warning = published.warning ?? null;
        }
      } catch (publishError) {
        warning = `The document was approved, but Xero publishing failed: ${publishError instanceof Error ? publishError.message : 'Please try publishing it manually.'}`;
      }
    }

    return jsonResponse(200, {
      success: true,
      receipt,
      warning,
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
