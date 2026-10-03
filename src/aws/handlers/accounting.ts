import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createAccount, createDocument, createJournal, createPayment, defaultAccounts, documentJournal, ledgerReport, paymentJournal, type AccountingDocument, type AccountingPayment, type JournalEntry, type LedgerAccount } from '../shared/accounting.js';
import { forbidden, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject } from '../shared/s3.js';

const pilotEmail = 'terryreedbfv@outlook.com';
async function scope(event: APIGatewayProxyEventV2) {
  const user = requireAuthenticatedUser(event);
  if (user.email.trim().toLowerCase() !== pilotEmail || user.role !== 'Business_Admin' || user.status !== 'active') throw forbidden('Accounting is locked for this account.');
  const current = await findUserByEmail(pilotEmail);
  if (!current || current.id !== user.id || current.organisationId !== user.organisationId || current.role !== 'Business_Admin' || current.status !== 'active') throw forbidden('Accounting is locked for this account.');
  return { user, prefix: `accounting/org-${user.organisationId}/` };
}
async function load<T>(prefix: string): Promise<T[]> {
  const keys = await listAllReceiptJsonKeys(prefix);
  return Promise.all(keys.filter((key) => key.endsWith('.json')).map((key) => getReceiptJsonObject<T>(key)));
}
async function accounts(prefix: string) {
  return [...defaultAccounts, ...await load<LedgerAccount>(`${prefix}accounts/`)];
}
function badRequest(message: string) {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = 400;
  return error;
}
function failure(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  return jsonResponse(status, { success: false, message: status === 500 ? 'Could not load or save accounting data.' : error instanceof Error ? error.message : 'Request failed.' });
}
export async function getHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix } = await scope(event);
    const [chart, manualEntries, documents, payments] = await Promise.all([accounts(prefix), load<JournalEntry>(`${prefix}journals/`), load<AccountingDocument>(`${prefix}documents/`), load<AccountingPayment>(`${prefix}payments/`)]);
    const documentMap = new Map(documents.map((document) => [document.id, document]));
    const entries = [...manualEntries, ...documents.map(documentJournal), ...payments.flatMap((payment) => {
      const document = documentMap.get(payment.documentId);
      return document ? [paymentJournal(payment, document)] : [];
    })];
    entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
    documents.sort((a, b) => b.date.localeCompare(a.date));
    return jsonResponse(200, { success: true, accounts: chart, entries, documents, payments, report: ledgerReport(chart, entries) });
  } catch (error) { return failure(error); }
}
export async function accountHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    let account: LedgerAccount;
    try { account = createAccount(data, await accounts(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid account.'); }
    await putReceiptJsonObject(`${prefix}accounts/${account.id}.json`, account);
    return jsonResponse(201, { success: true, account });
  } catch (error) { return failure(error); }
}
export async function journalHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    let entry: JournalEntry;
    try { entry = createJournal(data, await accounts(prefix), user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid journal.'); }
    await putReceiptJsonObject(`${prefix}journals/${entry.id}.json`, entry);
    return jsonResponse(201, { success: true, entry });
  } catch (error) { return failure(error); }
}
export async function documentHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    let document: AccountingDocument;
    try { document = createDocument(data, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid document.'); }
    const existing = await load<AccountingDocument>(`${prefix}documents/`);
    if (existing.some((item) => item.kind === document.kind && item.number.toLowerCase() === document.number.toLowerCase())) throw badRequest('That document number already exists.');
    await putReceiptJsonObject(`${prefix}documents/${document.id}.json`, document);
    return jsonResponse(201, { success: true, document });
  } catch (error) { return failure(error); }
}
export async function paymentHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const documentId = String(data.documentId ?? '');
    if (!/^[0-9a-f-]{36}$/.test(documentId)) throw badRequest('Choose a valid invoice or bill.');
    let document: AccountingDocument;
    try { document = await getReceiptJsonObject<AccountingDocument>(`${prefix}documents/${documentId}.json`); }
    catch { throw badRequest('Invoice or bill not found.'); }
    const existing = (await load<AccountingPayment>(`${prefix}payments/`)).filter((item) => item.documentId === documentId);
    let payment: AccountingPayment;
    try { payment = createPayment(data, document, existing, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid payment.'); }
    await putReceiptJsonObject(`${prefix}payments/${payment.id}.json`, payment);
    return jsonResponse(201, { success: true, payment });
  } catch (error) { return failure(error); }
}
