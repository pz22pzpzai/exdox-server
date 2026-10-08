import crypto from 'node:crypto';

import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import PostalMime from 'postal-mime';

import { canProcessDocument, isBillingActive, assertWorkspaceAccess } from '../shared/billing.js';
import { calculateContentSha256 } from '../shared/contentHash.js';
import { findCostsEmailAddress, getCostsEmailSubmission, saveCostsEmailSubmission, type CostsEmailSubmission } from '../shared/costsEmailStore.js';
import { applySupplierRulesToDocument, duplicateReceiptError, findDuplicateReceiptForOrganisation, findUserById, getOrganisationBillingSummary, getOrganisationTaxProfile, insertReceiptRecord } from '../shared/db.js';
import { awsEnv } from '../shared/env.js';
import { inferMimeType, sanitizeText } from '../shared/helpers.js';
import { applyVatRegistrationRules, processExpenseBuffer } from '../shared/openaiExtraction.js';
import { putReceiptObject } from '../shared/s3.js';
import { workspaceCountryLocale } from '../shared/workspaceCountry.js';

type SesRecord = {
  ses: {
    mail: { messageId: string; destination: string[]; timestamp: string };
    receipt?: { recipients?: string[]; spamVerdict?: { status?: string }; virusVerdict?: { status?: string } };
  };
};
type SesEvent = { Records: SesRecord[] };

const s3 = new S3Client({});
const allowedMime = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);

function supportedFile(buffer: Buffer, mimeType: string) {
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
  if (mimeType === 'image/jpeg') return buffer[0] === 0xff && buffer[1] === 0xd8;
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimeType === 'image/webp') return buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP';
  return false;
}

export async function handler(event: SesEvent) {
  for (const record of event.Records) await processRecord(record);
}

async function processRecord(record: SesRecord) {
  const mail = record.ses.mail;
  const messageId = mail.messageId;
  if (!/^[a-zA-Z0-9._-]{8,200}$/.test(messageId)) throw new Error('Invalid SES message identifier.');
  const recipients = record.ses.receipt?.recipients ?? mail.destination;
  const addressRows = await Promise.all(recipients.map((recipient) => findCostsEmailAddress(recipient)));
  const unique = [...new Map(addressRows.filter((row): row is NonNullable<typeof row> => Boolean(row)).map((row) => [row.address, row])).values()];
  if (unique.length !== 1) return;
  const address = unique[0];
  const existing = await getCostsEmailSubmission(address.organisationId, address.userId, messageId);
  if (existing?.status === 'completed' || existing?.status === 'duplicate') return;
  const base: CostsEmailSubmission = {
    id: messageId, organisationId: address.organisationId, userId: address.userId,
    receivedAt: mail.timestamp || new Date().toISOString(), subject: 'Email submission',
    status: 'failed', receiptIds: [], failures: [],
  };
  if (record.ses.receipt?.spamVerdict?.status === 'FAIL' || record.ses.receipt?.virusVerdict?.status === 'FAIL') {
    await saveCostsEmailSubmission({ ...base, failures: ['Message failed spam or malware checks.'] });
    return;
  }
  const owner = await findUserById(address.organisationId, address.userId);
  if (!owner || owner.status !== 'active') {
    await saveCostsEmailSubmission({ ...base, failures: ['The address owner is inactive.'] });
    return;
  }
  const billing = await getOrganisationBillingSummary(address.organisationId);
  if (!isBillingActive(billing)) {
    await saveCostsEmailSubmission({ ...base, failures: ['This workspace has no active plan.'] });
    return;
  }
  assertWorkspaceAccess(billing, 'cost');
  const result = await s3.send(new GetObjectCommand({ Bucket: process.env.INBOUND_EMAIL_BUCKET_NAME, Key: `costs/${messageId}` }));
  if (!result.Body) throw new Error('Raw email was missing.');
  const raw = Buffer.from(await result.Body.transformToByteArray());
  if (raw.length > 35 * 1024 * 1024) throw new Error('Email exceeds the allowed size.');
  const email = await PostalMime.parse(raw, { maxPartCount: 50, maxNestingDepth: 20, maxHeadersSize: 256 * 1024 });
  const taxProfile = await getOrganisationTaxProfile(address.organisationId);
  const receiptIds: number[] = [...(existing?.receiptIds ?? [])];
  const failures: string[] = [];
  if (email.attachments.length > 20) failures.push('Only the first 20 attachments were checked.');
  for (const [index, attachment] of email.attachments.slice(0, 20).entries()) {
    const filename = (sanitizeText(attachment.filename) || `cost-email-${index + 1}`).slice(0, 180);
    const mimeType = allowedMime.has(attachment.mimeType) ? attachment.mimeType : inferMimeType(filename);
    if (!allowedMime.has(mimeType)) { failures.push(`${filename}: unsupported attachment`); continue; }
    const content = typeof attachment.content === 'string'
      ? Buffer.from(attachment.content, attachment.encoding === 'base64' ? 'base64' : 'utf8')
      : Buffer.from(new Uint8Array(attachment.content));
    if (!content.length || content.length > 15 * 1024 * 1024 || !supportedFile(content, mimeType)) { failures.push(`${filename}: invalid or oversized file`); continue; }
    try {
      const latestBilling = await getOrganisationBillingSummary(address.organisationId);
      if (!canProcessDocument(latestBilling)) { failures.push(`${filename}: document allowance reached`); continue; }
      const extracted = await processExpenseBuffer({
        fileName: filename, mimeType, buffer: content,
        options: { locale: workspaceCountryLocale(taxProfile.country), country: taxProfile.country, extractLineItems: true, documentType: 'unknown', workspaceContext: 'cost', paymentMethod: 'bank_transfer', skipProcessing: false },
      });
      const ruled = await applySupplierRulesToDocument({ organisationId: address.organisationId, document: applyVatRegistrationRules(extracted, taxProfile), paymentMethod: 'bank_transfer', workspaceContext: 'cost' });
      const document = { ...ruled.document, needsReview: true };
      const contentSha256 = calculateContentSha256(content);
      const duplicate = await findDuplicateReceiptForOrganisation({ organisationId: address.organisationId, workspaceContext: 'cost', document, sourceFileName: filename, contentSha256 });
      if (duplicate) throw duplicateReceiptError('Error: Duplicate');
      const key = `incoming/org-${address.organisationId}/user-${address.userId}/costs-email/${messageId}-${index}-${crypto.randomUUID()}`;
      await putReceiptObject({ key, body: content, contentType: mimeType });
      receiptIds.push(await insertReceiptRecord({
        organisationId: address.organisationId, uploadedByUserId: address.userId, workspaceContext: 'cost', paymentMethod: ruled.paymentMethod,
        category: ruled.category, receiptSource: 'email', status: 'Review', sourceFileName: filename, sourceMimeType: mimeType,
        contentSha256, s3Bucket: awsEnv.receiptBucketName, s3Key: key, locale: workspaceCountryLocale(taxProfile.country),
        extractionProvider: 'openai', extractionModel: awsEnv.openAiModel, rawExtractionJson: extracted, document,
      }));
    } catch (error) {
      failures.push(`${filename}: ${error instanceof Error && /duplicate/i.test(error.message) ? 'duplicate document' : 'processing failed; upload this file manually or try again'}`);
    }
  }
  if (!email.attachments.length) failures.push('No supported attachment found.');
  const status = receiptIds.length ? failures.length ? 'partial' : 'completed' : failures.some((failure) => /duplicate/i.test(failure)) ? 'duplicate' : 'failed';
  await saveCostsEmailSubmission({ ...base, subject: sanitizeText(email.subject).slice(0, 160) || 'Email submission', status, receiptIds, failures });
}
