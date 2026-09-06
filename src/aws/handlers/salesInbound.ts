import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { assertWorkspaceAccess, canProcessDocument, isBillingActive } from '../shared/billing.js';
import { calculateContentSha256 } from '../shared/contentHash.js';
import {
  applySupplierRulesToDocument,
  duplicateReceiptError,
  findDuplicateReceiptForOrganisation,
  findUserById,
  getOrganisationBillingSummary,
  getOrganisationTaxProfile,
  insertReceiptRecord,
} from '../shared/db.js';
import { awsEnv } from '../shared/env.js';
import { inferMimeType, sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';
import { applyVatRegistrationRules, processExpenseBuffer } from '../shared/openaiExtraction.js';
import { putReceiptObject } from '../shared/s3.js';
import { findSubmissionAddress, matchSalesCustomerName, recordExternalSalesSubmission } from '../shared/salesWorkspaceStore.js';

type EmailAttachment = { filename?: unknown; mimeType?: unknown; base64?: unknown };

export async function handler(event: APIGatewayProxyEventV2) {
  const token = event.pathParameters?.token?.trim() ?? '';
  const address = token ? await findSubmissionAddress(token) : null;
  if (!address) return jsonResponse(404, { success: false, error: 'unknown_sales_address', message: 'This Sales submission address is not active.' });
  try {
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const attachments = Array.isArray(body.attachments) ? body.attachments as EmailAttachment[] : [];
    if (!attachments.length) throw Object.assign(new Error('The email did not contain a supported PDF or image attachment.'), { statusCode: 400 });
    const owner = await findUserById(address.organisationId, address.userId);
    if (!owner) throw Object.assign(new Error('The Sales submission owner no longer exists.'), { statusCode: 410 });
    const billing = await getOrganisationBillingSummary(address.organisationId);
    if (!isBillingActive(billing)) throw Object.assign(new Error('This workspace does not have an active subscription.'), { statusCode: 402 });
    assertWorkspaceAccess(billing, 'sales');
    const receiptIds: number[] = [];
    const failures: string[] = [];
    for (const attachment of attachments.slice(0, 20)) {
      const filename = sanitizeText(attachment.filename) || `sales-email-${Date.now()}.pdf`;
      const mimeType = sanitizeText(attachment.mimeType) || inferMimeType(filename);
      if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) { failures.push(`${filename}: unsupported file type`); continue; }
      if (!canProcessDocument(billing)) { failures.push(`${filename}: monthly document allowance reached`); continue; }
      const buffer = Buffer.from(String(attachment.base64 ?? ''), 'base64');
      if (!buffer.length || buffer.length > 15 * 1024 * 1024) { failures.push(`${filename}: empty or too large`); continue; }
      try {
        const contentSha256 = calculateContentSha256(buffer);
        const key = `incoming/org-${address.organisationId}/user-${address.userId}/sales/${Date.now()}-${cryptoSafe(filename)}`;
        const extracted = await processExpenseBuffer({
          fileName: filename, mimeType, buffer,
          options: { locale: 'en-GB', extractLineItems: true, documentType: 'invoice', workspaceContext: 'sales', paymentMethod: 'bank_transfer', skipProcessing: false },
        });
        const taxProfile = await getOrganisationTaxProfile(address.organisationId);
        const adjusted = applyVatRegistrationRules(extracted, taxProfile);
        const ruled = await applySupplierRulesToDocument({ organisationId: address.organisationId, document: adjusted, paymentMethod: 'bank_transfer', workspaceContext: 'sales' });
        let document = { ...ruled.document, needsReview: true };
        const matchedCustomer = await matchSalesCustomerName(address.organisationId, document.customer);
        if (matchedCustomer) document = { ...document, customer: matchedCustomer.name, notes: [...document.notes, `Matched saved customer: ${matchedCustomer.name}.`] };
        const duplicate = await findDuplicateReceiptForOrganisation({ organisationId: address.organisationId, workspaceContext: 'sales', document, sourceFileName: filename, contentSha256 });
        if (duplicate) throw duplicateReceiptError('Error: Duplicate');
        await putReceiptObject({ key, body: buffer, contentType: mimeType });
        receiptIds.push(await insertReceiptRecord({
          organisationId: address.organisationId, uploadedByUserId: address.userId, workspaceContext: 'sales', paymentMethod: ruled.paymentMethod,
          category: ruled.category, customer: document.customer, receiptSource: 'email', status: 'Review', sourceFileName: filename, sourceMimeType: mimeType,
          contentSha256, s3Bucket: awsEnv.receiptBucketName, s3Key: key, locale: 'en-GB', extractionProvider: 'openai', extractionModel: awsEnv.openAiModel,
          rawExtractionJson: extracted, document,
        }));
      } catch (error) { failures.push(`${filename}: ${error instanceof Error ? error.message : 'processing failed'}`); }
    }
    const status = receiptIds.length ? 'completed' : failures.some((item) => /duplicate/i.test(item)) ? 'duplicate' : 'failed';
    const submission = await recordExternalSalesSubmission(address, {
      channel: 'email', sourceFilename: sanitizeText(body.subject) || 'Email submission', splitMode: 'auto_detect', status,
      receiptIds, duplicateReceiptId: null, message: failures.length ? failures.join('; ').slice(0, 1000) : null,
    });
    return jsonResponse(receiptIds.length ? 200 : 422, { success: Boolean(receiptIds.length), receiptIds, failures, submission });
  } catch (error) {
    return jsonResponse(Number((error as { statusCode?: number }).statusCode ?? 500), { success: false, error: 'sales_email_failed', message: error instanceof Error ? error.message : 'Could not process the Sales email.' });
  }
}

function cryptoSafe(value: string) { return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-160); }
