import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createAccount, createDocument, createJournal, createPayment, defaultAccounts, documentJournal, ledgerReport, paymentJournal, type AccountingDocument, type AccountingPayment, type JournalEntry, type LedgerAccount } from '../shared/accounting.js';
import { bankEntries, createBankMatch, createBankStatement, type BankMatch, type BankStatement } from '../shared/accountingReconciliation.js';
import { forbidden, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject } from '../shared/s3.js';

const pilotEmail = 'terryreedbfv@outlook.com';
async function scope(event: APIGatewayProxyEventV2) {
  const user = requireAuthenticatedUser(event);
  if (user.email.trim().toLowerCase() !== pilotEmail || user.status !== 'active') throw forbidden('Accounting is locked for this account.');
  const current = await findUserByEmail(pilotEmail);
  if (!current || current.id !== user.id || current.organisationId !== user.organisationId || current.status !== 'active') throw forbidden('Accounting is locked for this account.');
  return { user, prefix: `accounting/org-${user.organisationId}/` };
}
async function load<T>(prefix: string): Promise<T[]> {
  const keys = await listAllReceiptJsonKeys(prefix);
  return Promise.all(keys.filter((key) => key.endsWith('.json')).map((key) => getReceiptJsonObject<T>(key)));
}
async function accounts(prefix: string) {
  return [...defaultAccounts, ...await load<LedgerAccount>(`${prefix}accounts/`)];
}
async function ledger(prefix: string) {
  const [manualEntries, documents, payments] = await Promise.all([load<JournalEntry>(`${prefix}journals/`), load<AccountingDocument>(`${prefix}documents/`), load<AccountingPayment>(`${prefix}payments/`)]);
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const entries = [...manualEntries, ...documents.map(documentJournal), ...payments.flatMap((payment) => {
    const document = documentMap.get(payment.documentId);
    return document ? [paymentJournal(payment, document)] : [];
  })];
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  documents.sort((a, b) => b.date.localeCompare(a.date));
  return { entries, documents, payments };
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
    const [chart, books, bankStatements, bankMatches] = await Promise.all([accounts(prefix), ledger(prefix), load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`)]);
    bankStatements.sort((a, b) => b.toDate.localeCompare(a.toDate));
    return jsonResponse(200, { success: true, accounts: chart, ...books, bankStatements, bankMatches, report: ledgerReport(chart, books.entries) });
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
export async function bankStatementHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    let statement: BankStatement;
    try { statement = createBankStatement(data, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid statement.'); }
    const existing = await load<BankStatement>(`${prefix}bank-statements/`);
    const duplicate = existing.find((item) => item.id === statement.id);
    if (duplicate) return jsonResponse(200, { success: true, statement: duplicate, alreadyImported: true });
    await putReceiptJsonObject(`${prefix}bank-statements/${statement.id}.json`, statement);
    return jsonResponse(201, { success: true, statement, alreadyImported: false });
  } catch (error) { return failure(error); }
}
export async function bankMatchHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    const [statements, matches, books] = await Promise.all([load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), ledger(prefix)]);
    let match: BankMatch;
    try { match = createBankMatch(data, statements, bankEntries(books.entries), matches, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid match.'); }
    await putReceiptJsonObject(`${prefix}bank-matches/${match.statementId}-${match.lineIndex}.json`, match);
    return jsonResponse(201, { success: true, match });
  } catch (error) { return failure(error); }
}
export async function bankUnmatchHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const statementId = String(data.statementId ?? '');
    const lineIndex = Number(data.lineIndex);
    if (!/^[0-9a-f]{64}$/.test(statementId) || !Number.isSafeInteger(lineIndex) || lineIndex < 0) throw badRequest('Choose a valid matched statement line.');
    const key = `${prefix}bank-matches/${statementId}-${lineIndex}.json`;
    try { await getReceiptJsonObject<BankMatch>(key); } catch { throw badRequest('That statement line is not matched.'); }
    await deleteReceiptObject(key);
    return jsonResponse(200, { success: true });
  } catch (error) { return failure(error); }
}
