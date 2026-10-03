import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createAccount, createDocument, createJournal, createPayment, defaultAccounts, documentJournal, ledgerReport, paymentJournal, type AccountingDocument, type AccountingPayment, type JournalEntry, type LedgerAccount } from '../shared/accounting.js';
import { bankEntries, createBankMatch, createBankStatement, duplicateStatementLines, suggestBankMatches, validateStatementSequence, type BankMatch, type BankStatement } from '../shared/accountingReconciliation.js';
import { createBankRule, createBankTransfer, matchingBankRules, ruleJournal, type BankRule } from '../shared/accountingBankAutomation.js';
import { assertOpenPeriod, createCreditNote, createPeriodLock, createReversal, creditJournal, lockedThrough, reversalJournal, type CreditNote, type PeriodLock, type Reversal } from '../shared/accountingSafeguards.js';
import { createSourcePosting, sourceJournal, type SourcePosting } from '../shared/accountingSourcePosting.js';
import { approveDraft, createAudit, createContact, createDraft, createRefund, createSettlement, latestVersions, refundJournal, settlementJournal, type AccountingAudit, type AccountingContact, type AccountingDraft, type AccountingRefund, type AccountingSettlement } from '../shared/accountingLifecycle.js';
import { sendAccountingInvoice } from '../shared/accountingInvoiceMail.js';
import { assertVatOpen, buildVatReport, createVatClassification, createVatClose, type VatClassification, type VatClose, type VatCode } from '../shared/accountingVat.js';
import { forbidden, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail, getOrganisationSettings, getReceiptById, listReceipts } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject, putReceiptJsonObjectIfAbsent, withReceiptObjectLock } from '../shared/s3.js';

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
async function withAccountingLock<T>(prefix: string, operation: () => Promise<T>) { return withReceiptObjectLock(`${prefix}write-lease.json`, operation); }
async function accounts(prefix: string) {
  return [...defaultAccounts, ...await load<LedgerAccount>(`${prefix}accounts/`)];
}
async function assertBankAccount(prefix: string, accountId: string) {
  if (!(await accounts(prefix)).some((item) => item.id === accountId && item.bank)) throw badRequest('Choose a bank account from the chart.');
}
async function periodLocks(prefix: string) { return load<PeriodLock>(`${prefix}period-locks/`); }
async function currentLock(prefix: string) { return lockedThrough(await periodLocks(prefix)); }
async function vatCloses(prefix: string) { return load<VatClose>(`${prefix}vat-closes/`); }
async function ledger(prefix: string) {
  const [manualEntries, documents, payments, creditNotes, reversals, sourcePostings, settlements, refunds] = await Promise.all([load<JournalEntry>(`${prefix}journals/`), load<AccountingDocument>(`${prefix}documents/`), load<AccountingPayment>(`${prefix}payments/`), load<CreditNote>(`${prefix}credit-notes/`), load<Reversal>(`${prefix}reversals/`), load<SourcePosting>(`${prefix}source-postings/`), load<AccountingSettlement>(`${prefix}settlements/`), load<AccountingRefund>(`${prefix}refunds/`)]);
  const documentMap = new Map(documents.map((document) => [document.id, document]));
  const creditMap = new Map(creditNotes.map((credit) => [credit.id, credit]));
  const baseEntries = [...manualEntries, ...documents.map(documentJournal), ...sourcePostings.map(sourceJournal), ...settlements.map(settlementJournal), ...refunds.flatMap((refund) => {
    const credit = creditMap.get(refund.creditId);
    const document = credit && documentMap.get(credit.documentId);
    return document ? [refundJournal(refund, document.kind === 'invoice')] : [];
  }), ...payments.flatMap((payment) => {
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
  return { entries, documents, payments, creditNotes, reversals, sourcePostings, settlements, refunds };
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
    const [chart, books, bankStatements, bankMatches, locks, drafts, contacts, audit, ruleVersions] = await Promise.all([accounts(prefix), ledger(prefix), load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), periodLocks(prefix), load<AccountingDraft>(`${prefix}draft-versions/`), load<AccountingContact>(`${prefix}contact-versions/`), load<AccountingAudit>(`${prefix}audit/`), load<BankRule>(`${prefix}bank-rule-versions/`)]);
    bankStatements.sort((a, b) => b.toDate.localeCompare(a.toDate));
    const bankRules = latestVersions(ruleVersions);
    const movements = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id));
    const bankSuggestions = bankStatements.flatMap((statement) => suggestBankMatches(statement, movements, bankMatches));
    const ruleSuggestions = bankStatements.flatMap((statement) => statement.lines.flatMap((line) => bankMatches.some((match) => match.statementId === statement.id && match.lineIndex === line.index) ? [] : matchingBankRules(statement, line, bankRules).slice(0, 1).map((rule) => ({ statementId: statement.id, lineIndex: line.index, ruleId: rule.id, counterAccountId: rule.counterAccountId }))));
    return jsonResponse(200, { success: true, accounts: chart, ...books, drafts: latestVersions(drafts), contacts: latestVersions(contacts), audit: audit.sort((a, b) => b.at.localeCompare(a.at)), bankStatements, bankMatches, bankRules, bankSuggestions, ruleSuggestions, periodLocks: locks, lockedThrough: lockedThrough(locks), report: ledgerReport(chart, books.entries) });
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
    return await withAccountingLock(prefix, async () => {
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
    });
  } catch (error) { return failure(error); }
}
export async function vatCloseHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
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
    });
  } catch (error) { return failure(error); }
}
export async function accountHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) : {};
    let account: LedgerAccount;
    try { account = createAccount(data, await accounts(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid account.'); }
    await putReceiptJsonObject(`${prefix}accounts/${account.id}.json`, account);
    return jsonResponse(201, { success: true, account });
    });
  } catch (error) { return failure(error); }
}
export async function journalHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) : {};
    let entry: JournalEntry;
    try { entry = createJournal(data, await accounts(prefix), user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid journal.'); }
    try { assertOpenPeriod(entry.date, await currentLock(prefix)); assertVatOpen(entry.date, await vatCloses(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
    await putReceiptJsonObject(`${prefix}journals/${entry.id}.json`, entry);
    return jsonResponse(201, { success: true, entry });
    });
  } catch (error) { return failure(error); }
}
export async function documentHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) : {};
    let document: AccountingDocument;
    try { document = createDocument(data, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid document.'); }
    try { assertOpenPeriod(document.date, await currentLock(prefix)); const closes = await vatCloses(prefix); assertVatOpen(document.date, closes); assertVatOpen(document.taxDate || document.date, closes); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
    const existing = await load<AccountingDocument>(`${prefix}documents/`);
    if (existing.some((item) => item.kind === document.kind && item.number.toLowerCase() === document.number.toLowerCase())) throw badRequest('That document number already exists.');
    await putReceiptJsonObject(`${prefix}documents/${document.id}.json`, document);
    return jsonResponse(201, { success: true, document });
    });
  } catch (error) { return failure(error); }
}
export async function contactHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const contacts = latestVersions(await load<AccountingContact>(`${prefix}contact-versions/`));
    const id = String(data.id ?? '');
    const prior = id ? contacts.find((item) => item.id === id) : undefined;
    if (id && (!prior || Number(data.version) !== prior.version)) throw badRequest('Contact changed. Refresh before editing.');
    let contact: AccountingContact;
    try { contact = createContact(data, user.email, prior); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid contact.'); }
    if (contacts.some((item) => item.id !== contact.id && item.name.toLowerCase() === contact.name.toLowerCase())) throw badRequest('A contact with this name already exists.');
    await putReceiptJsonObjectIfAbsent(`${prefix}contact-versions/${contact.id}-${contact.version}.json`, contact);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit(prior ? 'contact.updated' : 'contact.created', contact.id, contact.name, user.email));
    return jsonResponse(prior ? 200 : 201, { success: true, contact });
  } catch (error) { return failure(error); }
}
export async function draftHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const drafts = latestVersions(await load<AccountingDraft>(`${prefix}draft-versions/`));
    const id = String(data.id ?? '');
    const prior = id ? drafts.find((item) => item.id === id) : undefined;
    if (id && (!prior || Number(data.version) !== prior.version)) throw badRequest('Draft changed. Refresh before editing.');
    if (prior) {
      try { await getReceiptJsonObject<AccountingDocument>(`${prefix}documents/${id}.json`); throw badRequest('Approved documents cannot be edited.'); }
      catch (error) { if (error instanceof Error && 'statusCode' in error) throw error; }
    }
    const contactId = String(data.contactId ?? '');
    if (contactId) {
      const contact = latestVersions(await load<AccountingContact>(`${prefix}contact-versions/`)).find((item) => item.id === contactId);
      if (!contact || (data.kind === 'invoice' && contact.role === 'supplier') || (data.kind === 'bill' && contact.role === 'customer')) throw badRequest('Choose a contact of the matching type.');
      data.contactName = contact.name;
      if (data.kind === 'invoice') data.contactAddress = contact.address;
    }
    let draft: AccountingDraft;
    try { draft = createDraft(data, user.email, prior); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid draft.'); }
    try { await putReceiptJsonObjectIfAbsent(`${prefix}draft-versions/${draft.id}-${draft.version}.json`, draft); }
    catch { throw badRequest('Draft changed. Refresh before editing.'); }
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit(prior ? 'draft.updated' : 'draft.created', draft.id, `${draft.document.kind} ${draft.document.number} version ${draft.version}`, user.email));
    return jsonResponse(prior ? 200 : 201, { success: true, draft });
  } catch (error) { return failure(error); }
}
export async function approveDraftHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const draft = latestVersions(await load<AccountingDraft>(`${prefix}draft-versions/`)).find((item) => item.id === data.draftId);
    if (!draft || draft.version !== Number(data.version)) throw badRequest('Draft changed. Refresh before approving.');
    const document = approveDraft(draft, user.email);
    try { assertOpenPeriod(document.date, await currentLock(prefix)); const closes = await vatCloses(prefix); assertVatOpen(document.date, closes); assertVatOpen(document.taxDate || document.date, closes); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
    const existing = await load<AccountingDocument>(`${prefix}documents/`);
    if (existing.some((item) => item.kind === document.kind && item.number.toLowerCase() === document.number.toLowerCase())) throw badRequest('That document number already exists or this draft is already approved.');
    try { await putReceiptJsonObjectIfAbsent(`${prefix}documents/${document.id}.json`, document); }
    catch { throw badRequest('This draft is already approved. Refresh the document list.'); }
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('draft.approved', document.id, `${document.kind} ${document.number} posted to ledger`, user.email));
    return jsonResponse(201, { success: true, document });
    });
  } catch (error) { return failure(error); }
}
export async function sendInvoiceHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    if (data.confirm !== true) throw badRequest('Confirm the invoice recipient before sending.');
    const books = await ledger(prefix);
    const document = books.documents.find((item) => item.id === data.documentId && item.kind === 'invoice');
    if (!document || books.reversals.some((item) => item.targetEntryId === `document-${document.id}`)) throw badRequest('Choose an active posted invoice.');
    const recipient = String(data.recipient ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient) || recipient.length > 254) throw badRequest('Enter a valid recipient email.');
    const messageId = await sendAccountingInvoice(document, recipient);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('invoice.sent', document.id, `Sent ${document.number} to ${recipient}; SES message ${messageId ?? 'unknown'}`, user.email));
    return jsonResponse(200, { success: true, messageId });
  } catch (error) { return failure(error); }
}
function dueFor(document: AccountingDocument, books: Awaited<ReturnType<typeof ledger>>) {
  const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
  if (reversed.has(`document-${document.id}`)) return 0;
  return document.totalPence
    - books.creditNotes.filter((item) => item.documentId === document.id && !reversed.has(`credit-${item.id}`)).reduce((sum, item) => sum + item.totalPence, 0)
    - books.payments.filter((item) => item.documentId === document.id && !reversed.has(`payment-${item.id}`)).reduce((sum, item) => sum + item.amountPence, 0)
    - books.settlements.filter((item) => !reversed.has(`settlement-${item.id}`)).flatMap((item) => item.allocations).filter((item) => item.documentId === document.id).reduce((sum, item) => sum + item.amountPence, 0)
    + books.refunds.filter((item) => !reversed.has(`refund-${item.id}`) && books.creditNotes.some((credit) => credit.id === item.creditId && credit.documentId === document.id)).reduce((sum, item) => sum + item.amountPence, 0);
}
export async function settlementHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const prior = await priorRequest<AccountingSettlement>(prefix, 'settlements', data, (item) => item.kind === data.kind && (item.bankAccountId ?? '1000') === String(data.bankAccountId ?? '1000') && item.date === data.date && item.reference === String(data.reference ?? '').trim() && JSON.stringify(item.allocations) === JSON.stringify(data.allocations));
    if (prior) return jsonResponse(200, { success: true, settlement: prior, alreadyPosted: true });
    const books = await ledger(prefix);
    let settlement: AccountingSettlement;
    try { settlement = createSettlement(data, books.documents, (id) => dueFor(books.documents.find((item) => item.id === id)!, books), user.email); assertOpenPeriod(settlement.date, await currentLock(prefix)); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid settlement.'); }
    await assertBankAccount(prefix, settlement.bankAccountId ?? '1000');
    await putReceiptJsonObjectIfAbsent(`${prefix}settlements/${settlement.id}.json`, settlement);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('settlement.posted', settlement.id, `${settlement.kind} ${settlement.reference}: ${settlement.totalPence} pence across ${settlement.allocations.length} documents`, user.email));
    return jsonResponse(201, { success: true, settlement });
    });
  } catch (error) { return failure(error); }
}
export async function refundHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const prior = await priorRequest<AccountingRefund>(prefix, 'refunds', data, (item) => item.creditId === data.creditId && (item.bankAccountId ?? '1000') === String(data.bankAccountId ?? '1000') && item.date === data.date && item.reference === String(data.reference ?? '').trim() && item.amountPence === Number(data.amountPence));
    if (prior) return jsonResponse(200, { success: true, refund: prior, alreadyPosted: true });
    const books = await ledger(prefix);
    const credit = books.creditNotes.find((item) => item.id === data.creditId);
    const document = credit && books.documents.find((item) => item.id === credit.documentId);
    const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
    if (!credit || !document || reversed.has(`credit-${credit.id}`) || reversed.has(`document-${document.id}`)) throw badRequest('Choose an active credit note.');
    const refunds = books.refunds.filter((item) => books.creditNotes.some((candidate) => candidate.id === item.creditId && candidate.documentId === document.id) && !reversed.has(`refund-${item.id}`));
    const maxPence = Math.min(credit.totalPence - refunds.filter((item) => item.creditId === credit.id).reduce((sum, item) => sum + item.amountPence, 0), Math.max(0, -dueFor(document, books)));
    let refund: AccountingRefund;
    try { refund = createRefund(data, maxPence, user.email); if (refund.date < credit.date) throw new Error('Refund date cannot precede the credit note.'); assertOpenPeriod(refund.date, await currentLock(prefix)); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid refund.'); }
    await assertBankAccount(prefix, refund.bankAccountId ?? '1000');
    await putReceiptJsonObjectIfAbsent(`${prefix}refunds/${refund.id}.json`, refund);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('refund.posted', refund.id, `${credit.number}: ${refund.amountPence} pence`, user.email));
    return jsonResponse(201, { success: true, refund });
    });
  } catch (error) { return failure(error); }
}
export async function paymentHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const prior = await priorRequest<AccountingPayment>(prefix, 'payments', data, (item) => item.documentId === data.documentId && (item.bankAccountId ?? '1000') === String(data.bankAccountId ?? '1000') && item.date === data.date && item.reference === String(data.reference ?? '').trim() && item.amountPence === Number(data.amountPence));
    if (prior) return jsonResponse(200, { success: true, payment: prior, alreadyPosted: true });
    const documentId = String(data.documentId ?? '');
    if (!/^[0-9a-f-]{36}$/.test(documentId)) throw badRequest('Choose a valid invoice or bill.');
    let document: AccountingDocument;
    try { document = await getReceiptJsonObject<AccountingDocument>(`${prefix}documents/${documentId}.json`); }
    catch { throw badRequest('Invoice or bill not found.'); }
    const books = await ledger(prefix);
    if (books.reversals.some((item) => item.targetEntryId === `document-${documentId}`)) throw badRequest('This document has been voided.');
    const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
    const existing = books.payments.filter((item) => item.documentId === documentId && !reversed.has(`payment-${item.id}`));
    const creditedPence = books.creditNotes.filter((item) => item.documentId === documentId && !reversed.has(`credit-${item.id}`)).reduce((sum, item) => sum + item.totalPence, 0)
      + books.settlements.filter((item) => !reversed.has(`settlement-${item.id}`)).flatMap((item) => item.allocations).filter((item) => item.documentId === documentId).reduce((sum, item) => sum + item.amountPence, 0);
    let payment: AccountingPayment;
    try { payment = createPayment(data, document, existing, user.email, creditedPence); assertOpenPeriod(payment.date, await currentLock(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid payment.'); }
    await assertBankAccount(prefix, payment.bankAccountId ?? '1000');
    await putReceiptJsonObjectIfAbsent(`${prefix}payments/${payment.id}.json`, payment);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('payment.posted', payment.id, `${document.number}: ${payment.amountPence} pence`, user.email));
    return jsonResponse(201, { success: true, payment });
    });
  } catch (error) { return failure(error); }
}
export async function periodLockHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) : {};
    const events = await periodLocks(prefix);
    let lock: PeriodLock;
    try { lock = createPeriodLock(data, events, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid close date.'); }
    const [statements, matches, books, chart] = await Promise.all([load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), ledger(prefix), accounts(prefix)]);
    if (statements.some((item) => item.fromDate <= lock.lockedThrough && item.toDate > lock.lockedThrough)) throw badRequest('Close after the end of any imported statement that overlaps this date.');
    for (const statement of statements.filter((item) => item.toDate <= lock.lockedThrough)) {
      const matchedLines = matches.filter((item) => item.statementId === statement.id);
      const movements = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id)).filter((item) => item.accountId === (statement.accountId ?? '1000'));
      const bankBalance = movements.filter((item) => item.date <= statement.toDate).reduce((sum, item) => sum + item.amountPence, 0);
      const periodMovements = movements.filter((item) => item.date >= statement.fromDate && item.date <= statement.toDate);
      if (matchedLines.length !== statement.lines.length || periodMovements.some((item) => !matchedLines.some((match) => match.bankEntryId === item.id)) || bankBalance !== statement.closingPence) throw badRequest(`Reconcile ${statement.name} before closing this period.`);
    }
    await putReceiptJsonObject(`${prefix}period-locks/${lock.id}.json`, lock);
    return jsonResponse(201, { success: true, lock });
    });
  } catch (error) { return failure(error); }
}
export async function reverseHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const entryId = String(data.entryId ?? '');
    const books = await ledger(prefix);
    const original = books.entries.find((entry) => entry.id === entryId);
    if (!original) throw badRequest('Choose a posted entry to reverse.');
    const [matches, chart] = await Promise.all([load<BankMatch>(`${prefix}bank-matches/`), accounts(prefix)]);
    const movementIds = new Set(bankEntries([original], chart.filter((item) => item.bank).map((item) => item.id)).map((item) => item.id));
    if (matches.some((item) => movementIds.has(item.bankEntryId))) throw badRequest('Unmatch this bank movement before reversing its entry.');
    const reversed = new Set(books.reversals.map((item) => item.targetEntryId));
    if (entryId.startsWith('document-')) {
      const documentId = entryId.slice('document-'.length);
      if (books.payments.some((item) => item.documentId === documentId && !reversed.has(`payment-${item.id}`)) || books.creditNotes.some((item) => item.documentId === documentId && !reversed.has(`credit-${item.id}`)) || books.settlements.some((item) => item.allocations.some((allocation) => allocation.documentId === documentId) && !reversed.has(`settlement-${item.id}`))) throw badRequest('Reverse related payments, settlements and credit notes before voiding this document.');
    }
    if (entryId.startsWith('credit-') && books.refunds.some((item) => item.creditId === entryId.slice(7) && !reversed.has(`refund-${item.id}`))) throw badRequest('Reverse related refunds before reversing this credit note.');
    let reversal: Reversal;
    try { reversal = createReversal(data, original, books.reversals, await currentLock(prefix), user.email); assertVatOpen(reversal.date, await vatCloses(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Could not reverse entry.'); }
    await putReceiptJsonObject(`${prefix}reversals/${entryId}.json`, reversal);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('entry.reversed', entryId, reversal.reason, user.email));
    return jsonResponse(201, { success: true, reversal });
    });
  } catch (error) { return failure(error); }
}
export async function creditNoteHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
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
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('credit.posted', credit.id, `${credit.number} against ${document.number}: ${credit.totalPence} pence`, user.email));
    return jsonResponse(201, { success: true, credit });
    });
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
    return await withAccountingLock(prefix, async () => {
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
    });
  } catch (error) { return failure(error); }
}
export async function bankStatementHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) : {};
    let statement: BankStatement;
    try { statement = createBankStatement(data, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid statement.'); }
    if (!(await accounts(prefix)).some((item) => item.id === (statement.accountId ?? '1000') && item.bank)) throw badRequest('Choose a chart account marked as a bank account.');
    const existing = await load<BankStatement>(`${prefix}bank-statements/`);
    const duplicate = existing.find((item) => item.id === statement.id || ((item.accountId ?? '1000') === (statement.accountId ?? '1000') && item.openingPence === statement.openingPence && item.closingPence === statement.closingPence && JSON.stringify(item.lines) === JSON.stringify(statement.lines)));
    if (duplicate) return jsonResponse(200, { success: true, statement: duplicate, alreadyImported: true });
    try { assertOpenPeriod(statement.fromDate, await currentLock(prefix)); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
    const duplicateLines = duplicateStatementLines(statement, existing);
    if (duplicateLines.length) throw badRequest(`${duplicateLines.length} line(s) resemble transactions already imported for this bank account. Import a non-overlapping statement export instead.`);
    try { validateStatementSequence(statement, existing); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Statement ranges must not overlap.'); }
    await putReceiptJsonObjectIfAbsent(`${prefix}bank-statements/${statement.id}.json`, statement);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.statement_imported', statement.id, `${statement.name}: ${statement.lines.length} lines`, user.email));
    return jsonResponse(201, { success: true, statement, alreadyImported: false });
    });
  } catch (error) { return failure(error); }
}
async function priorRequest<T>(prefix: string, collection: string, data: Record<string, unknown>, same: (item: T) => boolean): Promise<T | null> {
  const requestId = String(data.requestId ?? '');
  if (!requestId) return null;
  if (!/^[0-9a-f-]{36}$/.test(requestId)) throw badRequest('Invalid request ID.');
  let prior: T;
  try { prior = await getReceiptJsonObject<T>(`${prefix}${collection}/${collection === 'journals' ? `transfer-${requestId}` : requestId}.json`); }
  catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && ['NoSuchKey', 'NotFound'].includes(String((error as { name?: string }).name))) return null;
    throw error;
  }
  if (!same(prior)) throw badRequest('That request ID was already used for different accounting details.');
  return prior;
}
export async function bankRuleHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const versions = latestVersions(await load<BankRule>(`${prefix}bank-rule-versions/`));
      const id = String(data.id ?? '');
      const prior = id ? versions.find((item) => item.id === id) : undefined;
      if (id && (!prior || Number(data.version) !== prior.version)) throw badRequest('Bank rule changed. Refresh before editing.');
      let rule: BankRule;
      try { rule = createBankRule(data, await accounts(prefix), user.email, prior); }
      catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid bank rule.'); }
      await putReceiptJsonObjectIfAbsent(`${prefix}bank-rule-versions/${rule.id}-${rule.version}.json`, rule);
      await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit(prior ? 'bank.rule_updated' : 'bank.rule_created', rule.id, `${rule.contains}: ${rule.counterAccountId}; ${rule.enabled ? 'enabled' : 'disabled'}`, user.email));
      return jsonResponse(prior ? 200 : 201, { success: true, rule });
    });
  } catch (error) { return failure(error); }
}
export async function bankRulePostHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const statementId = String(data.statementId ?? '');
      const lineIndex = Number(data.lineIndex);
      const ruleId = String(data.ruleId ?? '');
      const [statement, rules, existingMatches, chart, books] = await Promise.all([
        getReceiptJsonObject<BankStatement>(`${prefix}bank-statements/${statementId}.json`),
        load<BankRule>(`${prefix}bank-rule-versions/`),
        load<BankMatch>(`${prefix}bank-matches/`),
        accounts(prefix),
        ledger(prefix),
      ]);
      const line = statement.lines.find((item) => item.index === lineIndex);
      const rule = latestVersions(rules).find((item) => item.id === ruleId);
      if (!line || !rule || !matchingBankRules(statement, line, [rule]).length) throw badRequest('Choose a valid rule for this unmatched statement line.');
      const journal = ruleJournal(statement, line, rule, user.email);
      const existingMatch = existingMatches.find((item) => item.statementId === statement.id && item.lineIndex === line.index);
      if (existingMatch) {
        if (existingMatch.bankEntryId === `${journal.id}:0` || existingMatch.bankEntryId === `${journal.id}:1`) return jsonResponse(200, { success: true, entry: await getReceiptJsonObject<JournalEntry>(`${prefix}journals/${journal.id}.json`), match: existingMatch, alreadyPosted: true });
        throw badRequest('This statement line is already matched.');
      }
      const bankMovement = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id));
      const usedBankEntries = new Set(existingMatches.map((item) => item.bankEntryId));
      if (bankMovement.some((item) => item.accountId === (statement.accountId ?? '1000') && item.amountPence === line.amountPence && !usedBankEntries.has(item.id) && Math.abs(Date.parse(`${item.date}T00:00:00Z`) - Date.parse(`${line.date}T00:00:00Z`)) <= 30 * 86400000 && item.id !== `${journal.id}:0` && item.id !== `${journal.id}:1`)) throw badRequest('A bank ledger movement with this amount already exists nearby. Review and match it before posting a rule journal.');
      try { assertOpenPeriod(journal.date, await currentLock(prefix)); assertVatOpen(journal.date, await vatCloses(prefix)); }
      catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
      const journalKey = `${prefix}journals/${journal.id}.json`;
      let posted = journal;
      try { await putReceiptJsonObjectIfAbsent(journalKey, journal); }
      catch (error) {
        const status = typeof error === 'object' && error !== null && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
        if (status !== 412) throw error;
        posted = await getReceiptJsonObject<JournalEntry>(journalKey);
      }
      const movement = bankEntries([posted], chart.filter((item) => item.bank).map((item) => item.id));
      const match = createBankMatch({ statementId, lineIndex, bankEntryId: movement[0]?.id }, [statement], movement, existingMatches, user.email);
      await putReceiptJsonObjectIfAbsent(`${prefix}bank-matches/${statement.id}-${line.index}.json`, match);
      await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.rule_posted', journal.id, `${statement.name} line ${line.index + 1}: ${rule.contains}`, user.email));
      return jsonResponse(201, { success: true, entry: posted, match });
    });
  } catch (error) { return failure(error); }
}
export async function bankTransferHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const prior = await priorRequest<JournalEntry>(prefix, 'journals', data, (item) => item.date === data.date && item.reference === String(data.reference ?? '').trim() && item.lines.some((line) => line.accountId === data.fromAccountId && line.creditPence === Number(data.amountPence)) && item.lines.some((line) => line.accountId === data.toAccountId && line.debitPence === Number(data.amountPence)));
      if (prior) return jsonResponse(200, { success: true, entry: prior, alreadyPosted: true });
      let entry: JournalEntry;
      try { entry = createBankTransfer(data, await accounts(prefix), user.email); assertOpenPeriod(entry.date, await currentLock(prefix)); assertVatOpen(entry.date, await vatCloses(prefix)); }
      catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid bank transfer.'); }
      await putReceiptJsonObjectIfAbsent(`${prefix}journals/${entry.id}.json`, entry);
      await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.transfer_posted', entry.id, `${entry.reference}: ${entry.lines[0].debitPence} pence`, user.email));
      return jsonResponse(201, { success: true, entry });
    });
  } catch (error) { return failure(error); }
}
export async function bankMatchHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
    const data = event.body ? JSON.parse(event.body) : {};
    const [statements, matches, books, chart] = await Promise.all([load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), ledger(prefix), accounts(prefix)]);
    const movements = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id));
    let match: BankMatch;
    try { match = createBankMatch(data, statements, movements, matches, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid match.'); }
    const statement = statements.find((item) => item.id === match.statementId);
    const line = statement?.lines.find((item) => item.index === match.lineIndex);
    if (!line) throw badRequest('Statement line not found.');
    const bankEntry = movements.find((item) => item.id === match.bankEntryId);
    try { const through = await currentLock(prefix); assertOpenPeriod(line.date, through); assertOpenPeriod(bankEntry!.date, through); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
    await putReceiptJsonObjectIfAbsent(`${prefix}bank-matches/${match.statementId}-${match.lineIndex}.json`, match);
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.line_matched', match.statementId, `Line ${match.lineIndex + 1} to ${match.bankEntryId}`, user.email));
    return jsonResponse(201, { success: true, match });
    });
  } catch (error) { return failure(error); }
}
export async function bankUnmatchHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
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
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.line_unmatched', statementId, `Line ${lineIndex + 1}`, user.email));
    return jsonResponse(200, { success: true });
    });
  } catch (error) { return failure(error); }
}
