import crypto from 'node:crypto';

import { awsEnv } from './env.js';
import {
  deleteReceiptObject,
  getReceiptJsonObject,
  getReceiptObjectBuffer,
  listAllReceiptJsonKeys,
  listReceiptJsonKeys,
  putReceiptJsonObject,
  putReceiptObject,
} from './s3.js';
import { sendSalesDocumentEmail } from './salesDocumentMail.js';
import type {
  AuthenticatedUser,
  SalesCustomerRow,
  SalesDocumentKind,
  SalesDocumentRow,
  SalesDocumentStatus,
  SalesLineItem,
  SalesPaymentRow,
  SalesSubmissionAddressRow,
  SalesSubmissionRow,
} from '../types.js';

const SALES_ROOT = 'sales-workspace';
const MONEY_SCALE = 100;

export async function getSalesWorkspace(user: AuthenticatedUser) {
  const [customers, documents, submissions, submissionAddress] = await Promise.all([
    listJson<SalesCustomerRow>(`${SALES_ROOT}/org-${user.organisationId}/customers/`, 1000),
    listJson<SalesDocumentRow>(`${SALES_ROOT}/org-${user.organisationId}/documents/`, 1000),
    listJson<SalesSubmissionRow>(`${SALES_ROOT}/org-${user.organisationId}/submissions/`, 500),
    getOrCreateSubmissionAddress(user),
  ]);
  return {
    customers: (user.role === 'Business_Admin' ? customers : []).sort((a, b) => a.name.localeCompare(b.name)),
    documents: documents.filter((document) => user.role === 'Business_Admin' || document.createdByUserId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    submissions: submissions.filter((submission) => user.role === 'Business_Admin' || submission.submittedByUserId === user.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    submissionAddress,
  };
}

export async function saveSalesCustomer(user: AuthenticatedUser, input: Record<string, unknown>) {
  const name = text(input.name);
  if (!name) throw badRequest('Customer name is required.');
  const id = text(input.id) || crypto.randomUUID();
  const existing = await tryGet<SalesCustomerRow>(customerKey(user.organisationId, id));
  if (existing && existing.organisationId !== user.organisationId) throw forbidden();
  const now = new Date().toISOString();
  const customer: SalesCustomerRow = {
    id,
    organisationId: user.organisationId,
    name,
    contactName: nullableText(input.contactName),
    email: nullableText(input.email)?.toLowerCase() ?? null,
    phone: nullableText(input.phone),
    billingAddress: nullableText(input.billingAddress),
    shippingAddress: nullableText(input.shippingAddress),
    companyNumber: nullableText(input.companyNumber),
    vatNumber: nullableText(input.vatNumber),
    paymentTermsDays: clampInteger(input.paymentTermsDays, 0, 365, 30),
    currency: currency(input.currency),
    active: input.active !== false,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putReceiptJsonObject(customerKey(user.organisationId, id), customer);
  return customer;
}

export async function matchSalesCustomerName(organisationId: number, extractedName: string | null) {
  if (!extractedName?.trim()) return null;
  const target = normalizeMatch(extractedName);
  const customers = await listJson<SalesCustomerRow>(`${SALES_ROOT}/org-${organisationId}/customers/`, 1000);
  const exact = customers.find((customer) => customer.active && normalizeMatch(customer.name) === target);
  if (exact) return exact;
  return customers.find((customer) => {
    if (!customer.active) return false;
    const candidate = normalizeMatch(customer.name);
    return candidate.length >= 5 && (candidate.includes(target) || target.includes(candidate));
  }) ?? null;
}

export async function importSalesCustomers(user: AuthenticatedUser, rows: unknown[]) {
  const results: SalesCustomerRow[] = [];
  for (const row of rows.slice(0, 1000)) {
    if (!row || typeof row !== 'object') continue;
    const input = row as Record<string, unknown>;
    if (!text(input.name)) continue;
    results.push(await saveSalesCustomer(user, input));
  }
  return results;
}

export async function deleteSalesCustomer(user: AuthenticatedUser, id: string) {
  const documents = await listJson<SalesDocumentRow>(`${SALES_ROOT}/org-${user.organisationId}/documents/`, 1000);
  if (documents.some((document) => document.customerId === id && document.status !== 'void')) {
    throw badRequest('This customer is used by a sales document. Mark the customer inactive instead.');
  }
  await deleteReceiptObject(customerKey(user.organisationId, id));
}

export async function saveSalesDocument(user: AuthenticatedUser, input: Record<string, unknown>) {
  const kind = documentKind(input.kind);
  const id = text(input.id) || crypto.randomUUID();
  const existing = await tryGet<SalesDocumentRow>(documentKey(user.organisationId, id));
  const customerId = text(input.customerId) || existing?.customerId || '';
  const customer = customerId ? await tryGet<SalesCustomerRow>(customerKey(user.organisationId, customerId)) : null;
  if (!customer) throw badRequest('Choose a customer before saving the sales document.');
  const lineItems = normalizeLineItems(input.lineItems ?? existing?.lineItems);
  if (!lineItems.length) throw badRequest('Add at least one line item.');
  const totals = calculateTotals(lineItems);
  const payments = existing?.payments ?? [];
  const paidAmount = money(payments.reduce((total, payment) => total + payment.amount, 0));
  const requestedStatus = salesStatus(input.status ?? existing?.status ?? 'draft');
  const status = paidAmount >= totals.total && totals.total > 0 ? 'paid' : paidAmount > 0 ? 'part_paid' : requestedStatus;
  const now = new Date().toISOString();
  const document: SalesDocumentRow = {
    id,
    organisationId: user.organisationId,
    createdByUserId: existing?.createdByUserId ?? user.id,
    kind,
    number: text(input.number) || existing?.number || await nextDocumentNumber(user.organisationId, kind),
    customerId,
    customerName: customer.name,
    issueDate: date(input.issueDate) || existing?.issueDate || now.slice(0, 10),
    dueDate: nullableDate(input.dueDate) ?? existing?.dueDate ?? defaultDueDate(customer.paymentTermsDays),
    currency: currency(input.currency ?? existing?.currency ?? customer.currency),
    status,
    notes: nullableText(input.notes),
    linkedDocumentId: nullableText(input.linkedDocumentId),
    lineItems,
    ...totals,
    paidAmount,
    outstandingAmount: money(Math.max(0, totals.total - paidAmount)),
    payments,
    s3Key: existing?.s3Key ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await putReceiptJsonObject(documentKey(user.organisationId, id), document);
  await recordSalesSubmission(user, {
    channel: 'native', sourceFilename: `${document.number}.pdf`, splitMode: 'single_document', status: 'completed', receiptIds: [], duplicateReceiptId: null, message: `${label(kind)} saved.`,
  });
  return document;
}

export async function addSalesPayment(user: AuthenticatedUser, documentId: string, input: Record<string, unknown>) {
  const key = documentKey(user.organisationId, documentId);
  const document = await tryGet<SalesDocumentRow>(key);
  if (!document) throw notFound('Sales document not found.');
  if (user.role !== 'Business_Admin' && document.createdByUserId !== user.id) throw forbidden();
  if (document.kind === 'quote') throw badRequest('Payments can only be recorded against invoices and credit notes.');
  const amount = money(Number(input.amount));
  if (!(amount > 0) || amount > document.outstandingAmount) throw badRequest('Enter a payment no greater than the outstanding balance.');
  const payment: SalesPaymentRow = {
    id: crypto.randomUUID(),
    amount,
    paidAt: date(input.paidAt) || new Date().toISOString().slice(0, 10),
    method: text(input.method) || 'Bank transfer',
    reference: nullableText(input.reference),
    createdAt: new Date().toISOString(),
  };
  const payments = [...document.payments, payment];
  const paidAmount = money(payments.reduce((total, item) => total + item.amount, 0));
  const outstandingAmount = money(Math.max(0, document.total - paidAmount));
  const updated: SalesDocumentRow = {
    ...document, payments, paidAmount, outstandingAmount,
    status: outstandingAmount === 0 ? 'paid' : 'part_paid',
    updatedAt: new Date().toISOString(),
  };
  await putReceiptJsonObject(key, updated);
  return updated;
}

export async function convertQuoteToInvoice(user: AuthenticatedUser, documentId: string) {
  const quote = await tryGet<SalesDocumentRow>(documentKey(user.organisationId, documentId));
  if (!quote || quote.kind !== 'quote') throw badRequest('Choose a quote to convert.');
  const invoice = await saveSalesDocument(user, {
    kind: 'invoice', customerId: quote.customerId, currency: quote.currency, issueDate: new Date().toISOString().slice(0, 10),
    notes: quote.notes, linkedDocumentId: quote.id, lineItems: quote.lineItems, status: 'draft',
  });
  const updatedQuote = { ...quote, status: 'accepted' as const, updatedAt: new Date().toISOString() };
  await putReceiptJsonObject(documentKey(user.organisationId, quote.id), updatedQuote);
  return { quote: updatedQuote, invoice };
}

export async function getSalesDocumentPdf(user: AuthenticatedUser, documentId: string) {
  const key = documentKey(user.organisationId, documentId);
  const document = await tryGet<SalesDocumentRow>(key);
  if (!document) throw notFound('Sales document not found.');
  if (user.role !== 'Business_Admin' && document.createdByUserId !== user.id) throw forbidden();
  const pdfKey = `${SALES_ROOT}/org-${user.organisationId}/pdf/${document.id}.pdf`;
  if (!document.s3Key) {
    await putReceiptObject({ key: pdfKey, body: buildSimplePdf(document), contentType: 'application/pdf' });
    document.s3Key = pdfKey;
    document.updatedAt = new Date().toISOString();
    await putReceiptJsonObject(key, document);
  }
  return { document, pdfKey };
}

export async function issueSalesDocument(user: AuthenticatedUser, documentId: string) {
  const { document, pdfKey } = await getSalesDocumentPdf(user, documentId);
  const customer = await tryGet<SalesCustomerRow>(customerKey(user.organisationId, document.customerId));
  if (!customer?.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(customer.email)) throw badRequest('Add a valid customer email address before sending this document.');
  const messageId = await sendSalesDocumentEmail({ document, recipient: customer.email, pdf: await getReceiptObjectBuffer(pdfKey) });
  const updated: SalesDocumentRow = { ...document, status: document.kind === 'quote' ? 'issued' : document.status === 'paid' ? 'paid' : document.paidAmount > 0 ? 'part_paid' : 'issued', updatedAt: new Date().toISOString() };
  await putReceiptJsonObject(documentKey(user.organisationId, document.id), updated);
  return { document: updated, messageId };
}

export async function getOrCreateSubmissionAddress(user: AuthenticatedUser) {
  const key = addressKey(user.organisationId, user.id);
  const existing = await tryGet<SalesSubmissionAddressRow>(key);
  if (existing) return existing;
  const now = new Date().toISOString();
  const token = crypto.randomBytes(12).toString('hex');
  const domain = awsEnv.salesInboundDomain || 'sales.exdox.co.uk';
  const row: SalesSubmissionAddressRow = {
    organisationId: user.organisationId,
    userId: user.id,
    token,
    address: `sales-${token}@${domain}`,
    createdAt: now,
    updatedAt: now,
  };
  await putReceiptJsonObject(key, row);
  await putReceiptJsonObject(`${SALES_ROOT}/addresses/by-token/${token}.json`, row);
  return row;
}

export async function rotateSubmissionAddress(user: AuthenticatedUser) {
  const old = await tryGet<SalesSubmissionAddressRow>(addressKey(user.organisationId, user.id));
  if (old) await deleteReceiptObject(`${SALES_ROOT}/addresses/by-token/${old.token}.json`);
  await deleteReceiptObject(addressKey(user.organisationId, user.id));
  return getOrCreateSubmissionAddress(user);
}

export async function findSubmissionAddress(token: string) {
  return tryGet<SalesSubmissionAddressRow>(`${SALES_ROOT}/addresses/by-token/${token}.json`);
}

export async function recordSalesSubmission(user: AuthenticatedUser, input: Omit<SalesSubmissionRow, 'id' | 'organisationId' | 'submittedByUserId' | 'createdAt' | 'updatedAt'>) {
  const now = new Date().toISOString();
  const row: SalesSubmissionRow = {
    id: crypto.randomUUID(), organisationId: user.organisationId, submittedByUserId: user.id,
    ...input, createdAt: now, updatedAt: now,
  };
  await putReceiptJsonObject(submissionKey(user.organisationId, row.id), row);
  return row;
}

export async function recordExternalSalesSubmission(address: SalesSubmissionAddressRow, input: Omit<SalesSubmissionRow, 'id' | 'organisationId' | 'submittedByUserId' | 'createdAt' | 'updatedAt'>) {
  const now = new Date().toISOString();
  const row: SalesSubmissionRow = { id: crypto.randomUUID(), organisationId: address.organisationId, submittedByUserId: address.userId, ...input, createdAt: now, updatedAt: now };
  await putReceiptJsonObject(submissionKey(address.organisationId, row.id), row);
  return row;
}

function customerKey(organisationId: number, id: string) { return `${SALES_ROOT}/org-${organisationId}/customers/${id}.json`; }
function documentKey(organisationId: number, id: string) { return `${SALES_ROOT}/org-${organisationId}/documents/${id}.json`; }
function submissionKey(organisationId: number, id: string) { return `${SALES_ROOT}/org-${organisationId}/submissions/${id}.json`; }
function addressKey(organisationId: number, userId: number) { return `${SALES_ROOT}/org-${organisationId}/addresses/user-${userId}.json`; }

async function listJson<T>(prefix: string, limit: number) {
  const keys = await listReceiptJsonKeys(prefix, limit);
  return Promise.all(keys.filter((key) => key.endsWith('.json')).map((key) => getReceiptJsonObject<T>(key)));
}

async function tryGet<T>(key: string): Promise<T | null> {
  try { return await getReceiptJsonObject<T>(key); } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') return null;
    throw error;
  }
}

async function nextDocumentNumber(organisationId: number, kind: SalesDocumentKind) {
  const documents = await listJson<SalesDocumentRow>(`${SALES_ROOT}/org-${organisationId}/documents/`, 1000);
  const prefix = kind === 'invoice' ? 'INV' : kind === 'quote' ? 'QUO' : 'CRN';
  const year = new Date().getUTCFullYear();
  const count = documents.filter((item) => item.kind === kind && item.createdAt.startsWith(String(year))).length + 1;
  return `${prefix}-${year}-${String(count).padStart(4, '0')}`;
}

function normalizeLineItems(value: unknown): SalesLineItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Record<string, unknown>;
    const description = text(item.description);
    const quantity = Number(item.quantity);
    const unitPrice = Number(item.unitPrice);
    const taxRate = Number(item.taxRate ?? 0);
    if (!description || !(quantity > 0) || unitPrice < 0 || !Number.isFinite(taxRate)) return [];
    const netAmount = money(quantity * unitPrice);
    const taxAmount = money(netAmount * taxRate / 100);
    return [{ description, quantity, unitPrice: money(unitPrice), taxRate, netAmount, taxAmount, totalAmount: money(netAmount + taxAmount) }];
  });
}

function calculateTotals(items: SalesLineItem[]) {
  const subtotal = money(items.reduce((sum, item) => sum + item.netAmount, 0));
  const taxTotal = money(items.reduce((sum, item) => sum + item.taxAmount, 0));
  return { subtotal, taxTotal, total: money(subtotal + taxTotal) };
}

function buildSimplePdf(document: SalesDocumentRow) {
  const lines = [
    `Exdox ${label(document.kind)}`, document.number, `Customer: ${document.customerName}`,
    `Issue date: ${document.issueDate}`, document.dueDate ? `Due date: ${document.dueDate}` : '', '',
    ...document.lineItems.map((item) => `${item.description}  ${item.quantity} x ${item.unitPrice.toFixed(2)}  ${item.totalAmount.toFixed(2)}`),
    '', `Subtotal: ${document.currency} ${document.subtotal.toFixed(2)}`, `Tax: ${document.currency} ${document.taxTotal.toFixed(2)}`,
    `Total: ${document.currency} ${document.total.toFixed(2)}`, `Outstanding: ${document.currency} ${document.outstandingAmount.toFixed(2)}`,
  ].filter(Boolean).map((line) => line.replace(/[^\x20-\x7E]/g, '?').replace(/[()\\]/g, '\\$&'));
  const stream = `BT\n/F1 12 Tf\n50 790 Td\n${lines.map((line, index) => `${index ? '0 -20 Td\n' : ''}(${line}) Tj`).join('\n')}\nET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n `).join('\n')}\n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output, 'ascii');
}

function text(value: unknown) { return typeof value === 'string' ? value.trim().slice(0, 1000) : ''; }
function normalizeMatch(value: string) { return value.toLowerCase().replace(/[^a-z0-9]/g, ''); }
function nullableText(value: unknown) { return text(value) || null; }
function money(value: number) { if (!Number.isFinite(value)) return 0; return Math.round(value * MONEY_SCALE) / MONEY_SCALE; }
function currency(value: unknown) { const result = text(value).toUpperCase(); return /^[A-Z]{3}$/.test(result) ? result : 'GBP'; }
function date(value: unknown) { const result = text(value); return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : ''; }
function nullableDate(value: unknown) { return date(value) || null; }
function clampInteger(value: unknown, min: number, max: number, fallback: number) { const number = Number(value); return Number.isInteger(number) ? Math.min(max, Math.max(min, number)) : fallback; }
function documentKind(value: unknown): SalesDocumentKind { const result = text(value); if (result === 'invoice' || result === 'quote' || result === 'credit_note') return result; throw badRequest('Choose invoice, quote, or credit note.'); }
function salesStatus(value: unknown): SalesDocumentStatus { const result = text(value); if (['draft','issued','accepted','declined','part_paid','paid','void'].includes(result)) return result as SalesDocumentStatus; return 'draft'; }
function defaultDueDate(days: number) { const date = new Date(); date.setUTCDate(date.getUTCDate() + days); return date.toISOString().slice(0, 10); }
function label(kind: SalesDocumentKind) { return kind === 'credit_note' ? 'Credit note' : `${kind[0].toUpperCase()}${kind.slice(1)}`; }
function httpError(statusCode: number, code: string, message: string) { return Object.assign(new Error(message), { statusCode, code }); }
function badRequest(message: string) { return httpError(400, 'invalid_sales_request', message); }
function forbidden() { return httpError(403, 'sales_forbidden', 'This record does not belong to your workspace.'); }
function notFound(message: string) { return httpError(404, 'sales_not_found', message); }
