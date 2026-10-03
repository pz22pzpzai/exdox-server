import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createAccount, createDocument, createJournal, createPayment, defaultAccounts, documentJournal, ledgerReport, paymentJournal, type AccountingDocument, type AccountingPayment, type JournalEntry, type LedgerAccount } from '../shared/accounting.js';
import { bankEntries, createBankMatch, createBankStatement, type BankMatch, type BankStatement } from '../shared/accountingReconciliation.js';
import { assertOpenPeriod, createCreditNote, createPeriodLock, createReversal, creditJournal, lockedThrough, reversalJournal, type CreditNote, type PeriodLock, type Reversal } from '../shared/accountingSafeguards.js';
import { createSourcePosting, sourceJournal, type SourcePosting } from '../shared/accountingSourcePosting.js';
import { assertVatOpen, buildVatReport, createVatClassification, createVatClose, type VatClassification, type VatClose, type VatCode } from '../shared/accountingVat.js';
import { forbidden, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail, getOrganisationSettings, getReceiptById, listReceipts } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject, putReceiptJsonObjectIfAbsent } from '../shared/s3.js';

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
async function periodLocks(prefix: string) { return load<PeriodLock>(`${prefix}period-locks/`); }
async function currentLock(prefix: string) { return lockedThrough(await periodLocks(prefix)); }
async function vatCloses(prefix: string) { return load<VatClose>(`${prefix}vat-closes/`); }
async function ledger(prefix: string) {
  const [manualEntries, documents, payments, creditNotes, reversals, sourcePostings] = await Promise.all([load<JournalEntry>(`${prefix}journals/`), load<AccountingDocument>(`${prefix}documents/`), load<AccountingPayment>(`${prefix}payments/`), load<CreditNote>(`${prefix}credit-notes/`), load<Reversal>(`${prefix}reversals/`), load<SourcePosting>(`${prefix}source-postings/`)]);
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const baseEntries = [...manualEntries, ...documents.map(documentJournal), ...sourcePostings.map(sourceJournal), ...payments.flatMap((payment) => {
    const document = documentMap.get(payment.documentId);
    return document ? [paymentJournal(payment, document)] : [];
  }), ...creditNotes.flatMap((credit) => {
    const document = documentMap.get(credit.documentId);
    return document ? [creditJournal(credit, document)] : [];
  })];
  const entryMap = new Map(baseEntries.map((entry) => [entry.id, entry]));
  const entries = [...baseEntries, ...reversals.flatMap((reversal) => {
    const original = entryMap.get(reversal.targetEntryId);
    return original ? [reversalJournal(reversal, original)] : [];
  })];
  entries.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
  documents.sort((a, b) => b.date.localeCompare(a.date));
  return { entries, documents, payments, creditNotes, reversals, sourcePostings };
}
async function vatReport(prefix: string, fromDate: string, toDate: string) {
  const [books, classifications] = await Promise.all([ledger(prefix), load<VatClassification>(`${prefix}vat-classifications/`)]);
  return buildVatReport({ fromDate, toDate, ...books, classifications });
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
    const [chart, books, bankStatements, bankMatches, locks] = await Promise.all([accounts(prefix), ledger(prefix), load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), periodLocks(prefix)]);
    bankStatements.sort((a, b) => b.toDate.localeCompare(a.toDate));
    return jsonResponse(200, { success: true, accounts: chart, ...books, bankStatements, bankMatches, periodLocks: locks, lockedThrough: lockedThrough(locks), report: ledgerReport(chart, books.entries) });
  } catch (error) { return failure(error); }
}
export async function vatReportHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const settings = await getOrganisationSettings(user.organisationId);
    if (settings.country !== 'GB') throw badRequest('VAT reporting currently supports UK workspaces only.');
    const fromDate = String(event.queryStringParameters?.from ?? '');
    const toDate = String(event.queryStringParameters?.to ?? '');
    let report: Awaited<ReturnType<typeof vatReport>>;
    try { report = await vatReport(prefix, fromDate, toDate); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid VAT period.'); }
    return jsonResponse(200, { success: true, report, closes: await vatCloses(prefix) });
  } catch (error) { return failure(error); }
}
export async function vatClassificationHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const settings = await getOrganisationSettings(user.organisationId);
    if (settings.country !== 'GB') throw badRequest('VAT reporting currently supports UK workspaces only.');
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const entryId = String(data.entryId ?? '');
    if (!/^[a-zA-Z0-9:-]{1,150}$/.test(entryId)) throw badRequest('Choose a posted accounting entry.');
    const books = await ledger(prefix);
    const entry = books.entries.find((item) => item.id === entryId);
    if (!entry || entry.id.startsWith('payment-')) throw badRequest('Choose a VAT-relevant accounting entry.');
    const classifications = await load<VatClassification>(`${prefix}vat-classifications/`);
    const overview = buildVatReport({ fromDate: '1900-01-01', toDate: '9999-12-31', ...books, classifications });
    if (overview.rows.some((item) => item.entryId === entryId) && !overview.issues.some((item) => item.entryId === entryId)) throw badRequest('This entry is already classified for VAT.');
    let classification: VatClassification;
    try { classification = createVatClassification(data, entry, await vatCloses(prefix), user.email); assertOpenPeriod(classification.taxDate, await currentLock(prefix)); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid VAT classification.'); }
    try { await putReceiptJsonObjectIfAbsent(`${prefix}vat-classifications/${entryId}.json`, classification); }
    catch (error) {
      const status = typeof error === 'object' && error !== null && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
      if (status === 412) throw badRequest('This entry was already classified. Refresh the VAT report.');
      throw error;
    }
    return jsonResponse(201, { success: true, classification });
  } catch (error) { return failure(error); }
}
export async function vatCloseHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const settings = await getOrganisationSettings(user.organisationId);
    if (settings.country !== 'GB') throw badRequest('VAT reporting currently supports UK workspaces only.');
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const fromDate = String(data.fromDate ?? '');
    const toDate = String(data.toDate ?? '');
    if (data.standardAccrualConfirmed !== true) throw badRequest('Confirm the standard invoice-basis VAT report has been reviewed before closing.');
    let report: Awaited<ReturnType<typeof vatReport>>;
    try { report = await vatReport(prefix, fromDate, toDate); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid VAT period.'); }
    let close: VatClose;
    try { close = createVatClose(report, await vatCloses(prefix), user.email); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Could not close VAT period.'); }
    try { await putReceiptJsonObjectIfAbsent(`${prefix}vat-closes/${close.fromDate}-${close.toDate}.json`, close); }
    catch (error) {
      const status = typeof error === 'object' && error !== null && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
      if (status === 412) throw badRequest('This VAT period was already closed. Refresh the VAT report.');
      throw error;
    }
    return jsonResponse(201, { success: true, close });
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
    try { assertOpenPeriod(entry.date, await currentLock(prefix)); assertVatOpen(entry.date, await vatCloses(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
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
    try { assertOpenPeriod(document.date, await currentLock(prefix)); const closes = await vatCloses(prefix); assertVatOpen(document.date, closes); assertVatOpen(document.taxDate || document.date, closes); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
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
    const books = await ledger(prefix);
    if (books.reversals.some((item) => item.targetEntryId === `document-${documentId}`)) throw badRequest('This document has been voided.');
    const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
    const existing = books.payments.filter((item) => item.documentId === documentId && !reversed.has(`payment-${item.id}`));
    const creditedPence = books.creditNotes.filter((item) => item.documentId === documentId && !reversed.has(`credit-${item.id}`)).reduce((sum, item) => sum + item.totalPence, 0);
    let payment: AccountingPayment;
    try { payment = createPayment(data, document, existing, user.email, creditedPence); assertOpenPeriod(payment.date, await currentLock(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid payment.'); }
    await putReceiptJsonObject(`${prefix}payments/${payment.id}.json`, payment);
    return jsonResponse(201, { success: true, payment });
  } catch (error) { return failure(error); }
}
export async function periodLockHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    const events = await periodLocks(prefix);
    let lock: PeriodLock;
    try { lock = createPeriodLock(data, events, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid close date.'); }
    const [statements, matches, books] = await Promise.all([load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), ledger(prefix)]);
    if (statements.some((item) => item.fromDate <= lock.lockedThrough && item.toDate > lock.lockedThrough)) throw badRequest('Close after the end of any imported statement that overlaps this date.');
    for (const statement of statements.filter((item) => item.toDate <= lock.lockedThrough)) {
      const matchedLines = matches.filter((item) => item.statementId === statement.id);
      const movements = bankEntries(books.entries);
      const bankBalance = movements.filter((item) => item.date <= statement.toDate).reduce((sum, item) => sum + item.amountPence, 0);
      const periodMovements = movements.filter((item) => item.date >= statement.fromDate && item.date <= statement.toDate);
      if (matchedLines.length !== statement.lines.length || periodMovements.some((item) => !matchedLines.some((match) => match.bankEntryId === item.id)) || bankBalance !== statement.closingPence) throw badRequest(`Reconcile ${statement.name} before closing this period.`);
    }
    await putReceiptJsonObject(`${prefix}period-locks/${lock.id}.json`, lock);
    return jsonResponse(201, { success: true, lock });
  } catch (error) { return failure(error); }
}
export async function reverseHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const entryId = String(data.entryId ?? '');
    const books = await ledger(prefix);
    const original = books.entries.find((entry) => entry.id === entryId);
    if (!original) throw badRequest('Choose a posted entry to reverse.');
    const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
    if (entryId.startsWith('document-')) {
      const documentId = entryId.slice('document-'.length);
      if (books.payments.some((item) => item.documentId === documentId && !reversed.has(`payment-${item.id}`)) || books.creditNotes.some((item) => item.documentId === documentId && !reversed.has(`credit-${item.id}`))) throw badRequest('Reverse related payments and credit notes before voiding this document.');
    }
    let reversal: Reversal;
    try { reversal = createReversal(data, original, books.reversals, await currentLock(prefix), user.email); assertVatOpen(reversal.date, await vatCloses(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Could not reverse entry.'); }
    await putReceiptJsonObject(`${prefix}reversals/${entryId}.json`, reversal);
    return jsonResponse(201, { success: true, reversal });
  } catch (error) { return failure(error); }
}
export async function creditNoteHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const documentId = String(data.documentId ?? '');
    const books = await ledger(prefix);
    const document = books.documents.find((item) => item.id === documentId);
    if (!document) throw badRequest('Choose a posted invoice or bill.');
    const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
    if (reversed.has(`document-${documentId}`)) throw badRequest('This document has been voided.');
    const credits = books.creditNotes.filter((item) => item.documentId === documentId && !reversed.has(`credit-${item.id}`));
    const payments = books.payments.filter((item) => item.documentId === documentId && !reversed.has(`payment-${item.id}`));
    let credit: CreditNote;
    try { credit = createCreditNote(data, document, credits, payments, await currentLock(prefix), user.email); assertVatOpen(credit.date, await vatCloses(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid credit note.'); }
    if (books.creditNotes.some((item) => item.number.toLowerCase() === credit.number.toLowerCase())) throw badRequest('That credit note number already exists.');
    await putReceiptJsonObject(`${prefix}credit-notes/${credit.id}.json`, credit);
    return jsonResponse(201, { success: true, credit });
  } catch (error) { return failure(error); }
}
export async function sourceCandidatesHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const [settings, costs, sales, posted] = await Promise.all([
      getOrganisationSettings(user.organisationId),
      listReceipts(user, { workspaceContext: 'cost', limit: 500 }),
      listReceipts(user, { workspaceContext: 'sales', limit: 500 }),
      load<SourcePosting>(`${prefix}source-postings/`),
    ]);
    const postedById = new Map(posted.map((item) => [item.sourceId, item]));
    const candidates = [...costs, ...sales].map((receipt) => {
      let reason: string | null = null;
      try { createSourcePosting(receipt, settings.country, user.email); }
      catch (error) { reason = error instanceof Error ? error.message : 'Not eligible.'; }
      const posting = postedById.get(receipt.id);
      return {
        id: receipt.id, workspaceContext: receipt.workspaceContext, status: receipt.status,
        date: receipt.invoiceDate || receipt.createdAt.slice(0, 10),
        description: receipt.vendorName || receipt.customer || receipt.description || receipt.sourceFilename,
        totalAmount: receipt.totalAmount, netAmount: receipt.netAmount, vatAmount: receipt.vatAmount, reference: receipt.invoiceNumber,
        eligible: !reason && !posting, reason: posting ? 'Already posted to Accounting.' : reason,
        postedAt: posting?.createdAt ?? null,
        sourceChangedAfterPosting: Boolean(posting && posting.sourceUpdatedAt !== receipt.updatedAt),
      };
    });
    return jsonResponse(200, { success: true, candidates });
  } catch (error) { return failure(error); }
}
export async function sourcePostingHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const receiptId = Number(data.receiptId);
    if (!Number.isSafeInteger(receiptId) || receiptId <= 0 || data.confirmNoDuplicate !== true || !data.vatCode) throw badRequest('Choose a record and VAT code, then confirm it is not already in the Accounting ledger.');
    const key = `${prefix}source-postings/receipt-${receiptId}.json`;
    try {
      const existing = await getReceiptJsonObject<SourcePosting>(key);
      return jsonResponse(200, { success: true, posting: existing, alreadyPosted: true });
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'name' in error && !['NoSuchKey', 'NotFound'].includes(String((error as { name?: string }).name))) throw error;
    }
    const [receipt, settings, books] = await Promise.all([getReceiptById(user, receiptId), getOrganisationSettings(user.organisationId), ledger(prefix)]);
    let posting: SourcePosting;
    try { posting = createSourcePosting(receipt, settings.country, user.email, String(data.vatCode ?? '') as VatCode, String(data.taxDate ?? '')); assertOpenPeriod(posting.date, await currentLock(prefix)); const closes = await vatCloses(prefix); assertVatOpen(posting.date, closes); assertVatOpen(posting.taxDate || posting.date, closes); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Source record is not eligible.'); }
    if (receipt.invoiceNumber && books.documents.some((item) => item.number.toLowerCase() === receipt.invoiceNumber?.toLowerCase() && item.totalPence === posting.totalPence)) throw badRequest('An Accounting document already has this number and amount. Check for a duplicate.');
    try { await putReceiptJsonObjectIfAbsent(key, posting); }
    catch (error) {
      const status = typeof error === 'object' && error !== null && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
      if (status === 412) return jsonResponse(200, { success: true, posting: await getReceiptJsonObject<SourcePosting>(key), alreadyPosted: true });
      throw error;
    }
    return jsonResponse(201, { success: true, posting, alreadyPosted: false });
  } catch (error) { return failure(error); }
}
export async function bankStatementHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) : {};
    let statement: BankStatement;
    try { statement = createBankStatement(data, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid statement.'); }
    try { assertOpenPeriod(statement.fromDate, await currentLock(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
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
    const statement = statements.find((item) => item.id === match.statementId);
    const line = statement?.lines.find((item) => item.index === match.lineIndex);
    if (!line) throw badRequest('Statement line not found.');
    const bankEntry = bankEntries(books.entries).find((item) => item.id === match.bankEntryId);
    try { const through = await currentLock(prefix); assertOpenPeriod(line.date, through); assertOpenPeriod(bankEntry!.date, through); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
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
    const statement = (await load<BankStatement>(`${prefix}bank-statements/`)).find((item) => item.id === statementId);
    const line = statement?.lines.find((item) => item.index === lineIndex);
    if (!line) throw badRequest('Statement line not found.');
    try { assertOpenPeriod(line.date, await currentLock(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
    await deleteReceiptObject(key);
    return jsonResponse(200, { success: true });
  } catch (error) { return failure(error); }
}
