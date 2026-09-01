import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import multipart from 'lambda-multipart-parser';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess, canProcessDocument, getPlanLimitMessage, isBillingActive } from '../shared/billing.js';
import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptObjectBuffer, putReceiptObject } from '../shared/s3.js';
import { inferMimeType, readRequestOptions, sanitizeText } from '../shared/helpers.js';
import { applyVatRegistrationRules, processExpenseBuffer } from '../shared/openaiExtraction.js';
import {
  applySupplierRulesToDocument,
  duplicateReceiptError,
  findDuplicateReceiptForOrganisation,
  getOrganisationBillingSummary,
  getOrganisationBaseCurrency,
  getOrganisationTaxProfile,
  insertReceiptRecord,
  saveReceiptExchangeRate,
} from '../shared/db.js';
import { getHistoricalExchangeRate } from '../shared/exchangeRates.js';
import { type AuthenticatedUser, type DocumentType, type ExpenseRequestOptions, type NormalizedExpenseDocument } from '../types.js';
import { calculateContentSha256 } from '../shared/contentHash.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const contentType = event.headers['content-type'] ?? event.headers['Content-Type'] ?? '';
    const isMultipart = contentType.toLowerCase().includes('multipart/form-data');

    if (isMultipart) {
      return processMultipartEvent(event, user);
    }

    return processJsonEvent(event, user);
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'process_expense_failed';
    const message = error instanceof Error ? error.message : 'Could not process expense.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}

async function processMultipartEvent(event: APIGatewayProxyEventV2, user: AuthenticatedUser) {
  const parsed = await multipart.parse(event as never);
  const file = parsed.files?.[0];

  if (!file?.content || !file.filename) {
    return jsonResponse(400, {
      success: false,
      error: 'missing_file',
      message: 'Upload a receipt image or invoice PDF in the `file` field.',
    });
  }

  const requestedOptions = readRequestOptions({
    locale: parsed.locale,
    extract_line_items: parsed.extract_line_items,
    document_type: parsed.document_type,
    workspace_context: parsed.workspace_context,
    payment_method: parsed.payment_method,
    skip_processing: parsed.skip_processing,
  });
  const options = user.role === 'Standard_Employee' && requestedOptions.workspaceContext === 'cost'
    ? { ...requestedOptions, paymentMethod: 'cash_personal' as const }
    : requestedOptions;
  const billing = await getOrganisationBillingSummary(user.organisationId);

  if (!isBillingActive(billing)) {
    return jsonResponse(402, {
      success: false,
      error: 'billing_inactive',
      message: 'This workspace needs an active plan before new documents can be processed.',
    });
  }

  if (!canProcessDocument(billing)) {
    return jsonResponse(402, {
      success: false,
      error: 'plan_document_limit_reached',
      message: getPlanLimitMessage(billing, 'documents'),
    });
  }
  assertWorkspaceAccess(billing, options.workspaceContext);

  const fileBuffer = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content);
  const fileName = sanitizeText(file.filename) || `receipt-${Date.now()}.jpg`;
  const mimeType = sanitizeText(file.contentType) || inferMimeType(fileName);
  const contentSha256 = calculateContentSha256(fileBuffer);
  const s3Key = buildStorageKey(user.organisationId, user.id, fileName, options);

  await putReceiptObject({
    key: s3Key,
    body: fileBuffer,
    contentType: mimeType,
  });

  const extractedDocument = options.skipProcessing
    ? buildStoredDocumentPlaceholder(fileName, options.documentType, options.workspaceContext)
    : await processExpenseBuffer({
        fileName,
        mimeType,
        buffer: fileBuffer,
        options,
      });
  const taxProfile = await getOrganisationTaxProfile(user.organisationId);
  const vatAdjustedDocument = applyVatRegistrationRules(extractedDocument, taxProfile);
  const supplierRuleOutcome = await applySupplierRulesToDocument({
    organisationId: user.organisationId,
    document: vatAdjustedDocument,
    paymentMethod: options.paymentMethod,
    workspaceContext: options.workspaceContext,
  });
  const paymentMethod = supplierRuleOutcome.paymentMethod;
  // OCR may supply complete fields, but a cost or sales document still requires
  // a reviewer to approve it before it can move to Ready.
  const document =
    options.workspaceContext === 'vault'
      ? supplierRuleOutcome.document
      : { ...supplierRuleOutcome.document, needsReview: true };
  const duplicateReceipt = await findDuplicateReceiptForOrganisation({
    organisationId: user.organisationId,
    workspaceContext: options.workspaceContext,
    document,
    sourceFileName: fileName,
    contentSha256,
  });
  if (duplicateReceipt) {
    await deleteReceiptObject(s3Key);
    throw duplicateReceiptError('Error: Duplicate');
  }

  const receiptId = await insertReceiptRecord({
    organisationId: user.organisationId,
    uploadedByUserId: user.id,
    workspaceContext: options.workspaceContext,
    paymentMethod,
    category: supplierRuleOutcome.category,
    receiptSource: 'web_upload',
    status: determineInitialReceiptStatus(options, document),
    sourceFileName: fileName,
    sourceMimeType: mimeType,
    contentSha256,
    s3Bucket: awsEnv.receiptBucketName,
    s3Key,
    locale: options.locale,
    extractionProvider: 'openai',
    extractionModel: awsEnv.openAiModel,
    rawExtractionJson: extractedDocument,
    document,
  });

  const convertedDocument = await applyReceiptCurrencyConversion(user, receiptId, document);

  return jsonResponse(200, {
    success: true,
    receiptId,
    storage: {
      bucket: awsEnv.receiptBucketName,
      key: s3Key,
    },
    workspaceContext: options.workspaceContext,
    provider: {
      name: 'openai',
      model: awsEnv.openAiModel,
    },
    options,
    document: convertedDocument,
  });
}

async function processJsonEvent(event: APIGatewayProxyEventV2, user: AuthenticatedUser) {
  const payload = event.body ? (JSON.parse(event.body) as Record<string, string | undefined>) : {};
  const s3Key = sanitizeText(payload.s3Key);

  if (!s3Key) {
    return jsonResponse(400, {
      success: false,
      error: 'missing_s3_key',
      message: 'Provide an `s3Key` when calling the JSON processing route.',
    });
  }

  const fileName = sanitizeText(payload.fileName) || s3Key.split('/').pop() || `receipt-${Date.now()}.jpg`;
  const mimeType = sanitizeText(payload.mimeType) || inferMimeType(fileName);
  const requestedOptions = readRequestOptions({
    locale: payload.locale,
    extract_line_items: payload.extract_line_items,
    document_type: payload.document_type,
    workspace_context: payload.workspace_context,
    payment_method: payload.payment_method,
    skip_processing: payload.skip_processing,
  });
  const options = user.role === 'Standard_Employee' && requestedOptions.workspaceContext === 'cost'
    ? { ...requestedOptions, paymentMethod: 'cash_personal' as const }
    : requestedOptions;
  const billing = await getOrganisationBillingSummary(user.organisationId);

  if (!isBillingActive(billing)) {
    return jsonResponse(402, {
      success: false,
      error: 'billing_inactive',
      message: 'This workspace needs an active plan before new documents can be processed.',
    });
  }

  if (!canProcessDocument(billing)) {
    return jsonResponse(402, {
      success: false,
      error: 'plan_document_limit_reached',
      message: getPlanLimitMessage(billing, 'documents'),
    });
  }
  assertWorkspaceAccess(billing, options.workspaceContext);

  if (!isAllowedStorageKey(s3Key, user.organisationId, user.id, options.workspaceContext)) {
    return jsonResponse(403, {
      success: false,
      error: 'forbidden_s3_key',
      message: 'This upload key does not belong to the signed-in user.',
    });
  }

  const fileBuffer = await getReceiptObjectBuffer(s3Key);
  const contentSha256 = calculateContentSha256(fileBuffer);
  const extractedDocument = options.skipProcessing
    ? buildStoredDocumentPlaceholder(fileName, options.documentType, options.workspaceContext)
    : await processExpenseBuffer({
        fileName,
        mimeType,
        buffer: fileBuffer,
        options,
      });
  const taxProfile = await getOrganisationTaxProfile(user.organisationId);
  const vatAdjustedDocument = applyVatRegistrationRules(extractedDocument, taxProfile);
  const supplierRuleOutcome = await applySupplierRulesToDocument({
    organisationId: user.organisationId,
    document: vatAdjustedDocument,
    paymentMethod: options.paymentMethod,
    workspaceContext: options.workspaceContext,
  });
  const paymentMethod = supplierRuleOutcome.paymentMethod;
  // Keep JSON/direct-to-storage uploads on the same review-first workflow as
  // multipart web and mobile uploads.
  const document =
    options.workspaceContext === 'vault'
      ? supplierRuleOutcome.document
      : { ...supplierRuleOutcome.document, needsReview: true };
  const duplicateReceipt = await findDuplicateReceiptForOrganisation({
    organisationId: user.organisationId,
    workspaceContext: options.workspaceContext,
    document,
    sourceFileName: fileName,
    contentSha256,
  });
  if (duplicateReceipt) {
    await deleteReceiptObject(s3Key);
    throw duplicateReceiptError('Error: Duplicate');
  }

  const receiptId = await insertReceiptRecord({
    organisationId: user.organisationId,
    uploadedByUserId: user.id,
    workspaceContext: options.workspaceContext,
    paymentMethod,
    category: supplierRuleOutcome.category,
    receiptSource: 'web_upload',
    status: determineInitialReceiptStatus(options, document),
    sourceFileName: fileName,
    sourceMimeType: mimeType,
    contentSha256,
    s3Bucket: awsEnv.receiptBucketName,
    s3Key,
    locale: options.locale,
    extractionProvider: 'openai',
    extractionModel: awsEnv.openAiModel,
    rawExtractionJson: extractedDocument,
    document,
  });
  const convertedDocument = await applyReceiptCurrencyConversion(user, receiptId, document);

  return jsonResponse(200, {
    success: true,
    receiptId,
    storage: {
      bucket: awsEnv.receiptBucketName,
      key: s3Key,
    },
    workspaceContext: options.workspaceContext,
    provider: {
      name: 'openai',
      model: awsEnv.openAiModel,
    },
    options,
    document: convertedDocument,
  });
}

async function applyReceiptCurrencyConversion(
  user: AuthenticatedUser,
  receiptId: number,
  document: NormalizedExpenseDocument,
) {
  const baseCurrency = await getOrganisationBaseCurrency(user.organisationId);
  const sourceCurrency = document.currency?.trim().toUpperCase() || baseCurrency;
  const exchangeRate = sourceCurrency === baseCurrency
    ? { rate: 1, rateDate: document.invoiceDate ?? new Date().toISOString().slice(0, 10), provider: 'same_currency' as const }
    : await getHistoricalExchangeRate({ fromCurrency: sourceCurrency, toCurrency: baseCurrency, documentDate: document.invoiceDate });
  const baseTotalAmount =
    exchangeRate && document.totalAmount !== null ? Number((document.totalAmount * exchangeRate.rate).toFixed(2)) : null;

  if (exchangeRate) {
    await saveReceiptExchangeRate({
      user,
      receiptId,
      baseCurrency,
      exchangeRate: exchangeRate.rate,
      exchangeRateDate: exchangeRate.rateDate,
      exchangeRateProvider: exchangeRate.provider,
      baseTotalAmount,
    });
  }

  return {
    ...document,
    currency: sourceCurrency,
    baseCurrency,
    exchangeRate: exchangeRate?.rate ?? null,
    exchangeRateDate: exchangeRate?.rateDate ?? null,
    exchangeRateProvider: exchangeRate?.provider ?? null,
    baseTotalAmount,
    exchangeRateOverride: false,
    exchangeRateNote: null,
  };
}

function determineInitialReceiptStatus(
  options: ExpenseRequestOptions,
  _document: { needsReview: boolean },
): 'Processing' | 'Review' | 'Ready' {
  if (options.workspaceContext === 'vault' && options.skipProcessing) {
    return 'Ready';
  }
  if (options.skipProcessing) {
    return 'Processing';
  }
  return options.workspaceContext === 'vault' ? 'Ready' : 'Review';
}

function buildStorageKey(
  organisationId: number,
  userId: number,
  fileName: string,
  options: ExpenseRequestOptions,
) {
  const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const datePrefix = new Date().toISOString().slice(0, 10);
  if (options.workspaceContext === 'vault') {
    return `vault/org-${organisationId}/${datePrefix}/${Date.now()}-${safeName}`;
  }
  return `receipts/org-${organisationId}/${options.workspaceContext}/user-${userId}/${datePrefix}/${Date.now()}-${safeName}`;
}

function isAllowedStorageKey(
  key: string,
  organisationId: number,
  userId: number,
  workspaceContext: ExpenseRequestOptions['workspaceContext'],
) {
  const receiptPrefix = `receipts/org-${organisationId}/${workspaceContext}/user-${userId}/`;
  const vaultPrefix = `vault/org-${organisationId}/`;
  return workspaceContext === 'vault' ? key.startsWith(vaultPrefix) : key.startsWith(receiptPrefix);
}

function buildStoredDocumentPlaceholder(
  fileName: string,
  documentType: DocumentType,
  workspaceContext: ExpenseRequestOptions['workspaceContext'],
): NormalizedExpenseDocument {
  const cleanName = sanitizeText(fileName.replace(/\.[^/.]+$/, '').replace(/[-_]/g, ' ')) || 'Uploaded document';
  return {
    vendorName: cleanName,
    invoiceDate: null,
    dueDate: null,
    invoiceNumber: null,
    currency: 'GBP',
    totalAmount: 0,
    netAmount: 0,
    vatAmount: 0,
    taxRateApplied: 'No VAT',
    subtotalAmount: null,
    totalTaxAmount: null,
    documentType,
    confidenceScore: null,
    confidenceSource: 'unavailable',
    needsReview: workspaceContext === 'vault' ? false : true,
    lineItems: [],
    taxBreakdown: [],
    notes: [workspaceContext === 'vault' ? 'Stored as a processed vault document.' : 'Stored without OCR processing.'],
    rawTextSummary: workspaceContext === 'vault' ? 'Stored as a processed vault document.' : 'Saved without OCR processing.',
  };
}
