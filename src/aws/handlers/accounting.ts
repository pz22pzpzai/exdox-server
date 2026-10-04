import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { createAccount, createDocument, createJournal, createPayment, defaultAccounts, documentJournal, ledgerReport, paymentJournal, type AccountingDocument, type AccountingPayment, type JournalEntry, type LedgerAccount } from '../shared/accounting.js';
import { bankEntries, createBankMatch, createBankStatement, duplicateStatementLines, likelyExistingBankMovement, suggestBankMatches, validateStatementSequence, type BankMatch, type BankStatement } from '../shared/accountingReconciliation.js';
import { createBankRule, createBankTransfer, matchingBankRules, ruleJournal, type BankRule } from '../shared/accountingBankAutomation.js';
import { assertOpenPeriod, createCreditNote, createPeriodLock, createReversal, creditJournal, lockedThrough, reversalJournal, type CreditNote, type PeriodLock, type Reversal } from '../shared/accountingSafeguards.js';
import { createSourcePosting, sourceJournal, type SourcePosting } from '../shared/accountingSourcePosting.js';
import { approveDraft, createAudit, createContact, createDraft, createRefund, createSettlement, latestVersions, refundJournal, settlementJournal, type AccountingAudit, type AccountingContact, type AccountingDraft, type AccountingRefund, type AccountingSettlement } from '../shared/accountingLifecycle.js';
import { sendAccountingInvoice, sendAccountingReminder } from '../shared/accountingInvoiceMail.js';
import { defaultReminderSettings, reminderCandidate, type AccountingEmailRecord, type AccountingReminderSettings } from '../shared/accountingReminders.js';
import { advanceRecurrence, createRecurrence, recurringDraft, type AccountingRecurrence } from '../shared/accountingRecurring.js';
import { buildAgingReport } from '../shared/accountingAging.js';
import { assertVatOpen, buildVatReport, createVatClassification, createVatClose, type VatClassification, type VatClose, type VatCode } from '../shared/accountingVat.js';
import { buildVatFilingPreview } from '../shared/accountingVatFiling.js';
import { normalizeFeedTransaction, type BankFeedConnection, type BankFeedMatch, type BankFeedTransaction } from '../shared/accountingBankFeed.js';
import { bankFeedConfigured, bankFeedEnvironment, connectedAccounts, createDataConnection, readTransactions, startTransactions } from '../shared/truelayerBankFeed.js';
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
async function optionalObject<T>(key: string): Promise<T | null> {
  try { return await getReceiptJsonObject<T>(key); }
  catch (error) {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (value.name === 'NoSuchKey' || value.name === 'NotFound' || value.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
const feedConnectionKey = (prefix: string) => `${prefix}bank-feed/connection.json`;
const sourceIp = (event: APIGatewayProxyEventV2) => event.requestContext?.http?.sourceIp ?? (event as APIGatewayProxyEventV2 & { requestContext?: { identity?: { sourceIp?: string } } }).requestContext?.identity?.sourceIp;
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
async function materializeRecurrences(prefix: string, today: string) {
  await withAccountingLock(prefix, async () => {
    const deadline = Date.now() + 20_000;
    const schedules = await load<AccountingRecurrence>(`${prefix}recurrences/`);
    for (const schedule of schedules.filter((item) => !item.paused)) {
      if (Date.now() >= deadline) break;
      let nextDate = schedule.nextDate;
      let created = 0;
      while (nextDate <= today && created < 12 && Date.now() < deadline) {
        const draft = recurringDraft(schedule, nextDate);
        const key = `${prefix}draft-versions/${draft.id}-1.json`;
        if (!await optionalObject<AccountingDraft>(key)) {
          const existing = latestVersions(await load<AccountingDraft>(`${prefix}draft-versions/`));
          const posted = await load<AccountingDocument>(`${prefix}documents/`);
          if (existing.some((item) => item.document.kind === schedule.kind && item.document.number.toLowerCase() === draft.document.number.toLowerCase()) || posted.some((item) => item.kind === schedule.kind && item.number.toLowerCase() === draft.document.number.toLowerCase())) {
            await putReceiptJsonObject(`${prefix}recurrences/${schedule.id}.json`, { ...schedule, nextDate, paused: true, lastError: `Number ${draft.document.number} is already in use. Choose a different prefix in a new schedule.` });
            break;
          }
          await putReceiptJsonObjectIfAbsent(key, draft);
          await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('recurrence.draft_created', draft.id, `${schedule.kind} ${draft.document.number} awaits approval`, 'Accounting schedule'));
        }
        nextDate = advanceRecurrence(schedule, nextDate);
        created += 1;
      }
      if (nextDate !== schedule.nextDate) {
        const current = await getReceiptJsonObject<AccountingRecurrence>(`${prefix}recurrences/${schedule.id}.json`);
        await putReceiptJsonObject(`${prefix}recurrences/${schedule.id}.json`, { ...current, nextDate });
      }
    }
  });
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
    try { await materializeRecurrences(prefix, new Date().toISOString().slice(0, 10)); }
    catch (error) { if (!(typeof error === 'object' && error !== null && 'statusCode' in error && Number((error as { statusCode: number }).statusCode) === 409)) throw error; }
    const [chart, books, bankStatements, bankMatches, locks, drafts, contacts, audit, ruleVersions, feedTransactions, feedMatches, recurrences, emailRecords, reminderSettings] = await Promise.all([accounts(prefix), ledger(prefix), load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), periodLocks(prefix), load<AccountingDraft>(`${prefix}draft-versions/`), load<AccountingContact>(`${prefix}contact-versions/`), load<AccountingAudit>(`${prefix}audit/`), load<BankRule>(`${prefix}bank-rule-versions/`), load<BankFeedTransaction>(`${prefix}bank-feed/transactions/`), load<BankFeedMatch>(`${prefix}bank-feed/matches/`), load<AccountingRecurrence>(`${prefix}recurrences/`), load<AccountingEmailRecord>(`${prefix}invoice-emails/`), optionalObject<AccountingReminderSettings>(`${prefix}reminder-settings.json`)]);
    bankStatements.sort((a, b) => b.toDate.localeCompare(a.toDate));
    const bankRules = latestVersions(ruleVersions);
    const movements = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id));
    const bankSuggestions = bankStatements.flatMap((statement) => suggestBankMatches(statement, movements, bankMatches));
    const ruleSuggestions = bankStatements.flatMap((statement) => statement.lines.flatMap((line) => bankMatches.some((match) => match.statementId === statement.id && match.lineIndex === line.index) ? [] : matchingBankRules(statement, line, bankRules).slice(0, 1).map((rule) => ({ statementId: statement.id, lineIndex: line.index, ruleId: rule.id, counterAccountId: rule.counterAccountId }))));
    return jsonResponse(200, { success: true, accounts: chart, ...books, drafts: latestVersions(drafts), contacts: latestVersions(contacts), recurrences, emailRecords, reminderSettings: reminderSettings ?? defaultReminderSettings, audit: audit.sort((a, b) => b.at.localeCompare(a.at)), bankStatements, bankMatches, feedTransactions: feedTransactions.sort((a, b) => b.date.localeCompare(a.date)), feedMatches, bankRules, bankSuggestions, ruleSuggestions, periodLocks: locks, lockedThrough: lockedThrough(locks), report: ledgerReport(chart, books.entries) });
  } catch (error) { return failure(error); }
}
export async function agingReportHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix } = await scope(event);
    const asOf = String(event.queryStringParameters?.asOf ?? new Date().toISOString().slice(0, 10));
    let report;
    try { report = buildAgingReport(asOf, await ledger(prefix)); }
    catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid report date.'); }
    return jsonResponse(200, { success: true, report });
  } catch (error) { return failure(error); }
}
export async function recurrenceHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const action = String(data.action ?? 'create');
      if (action === 'create') {
        const draft = latestVersions(await load<AccountingDraft>(`${prefix}draft-versions/`)).find((item) => item.id === data.draftId);
        if (!draft) throw badRequest('Choose a saved invoice or bill draft.');
        let schedule: AccountingRecurrence;
        try { schedule = createRecurrence(data, draft, user.email, new Date().toISOString().slice(0, 10)); }
        catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid schedule.'); }
        const existing = await load<AccountingRecurrence>(`${prefix}recurrences/`);
        if (existing.some((item) => item.kind === schedule.kind && item.numberPrefix.toLowerCase() === schedule.numberPrefix.toLowerCase())) throw badRequest('Use a different number prefix for this schedule.');
        await putReceiptJsonObjectIfAbsent(`${prefix}recurrences/${schedule.id}.json`, schedule);
        await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('recurrence.created', schedule.id, `${schedule.label} starts ${schedule.nextDate}`, user.email));
        return jsonResponse(201, { success: true, schedule });
      }
      if (action !== 'pause' && action !== 'resume') throw badRequest('Invalid schedule action.');
      const id = String(data.id ?? '');
      const schedule = await optionalObject<AccountingRecurrence>(`${prefix}recurrences/${id}.json`);
      if (!schedule || schedule.id !== id) throw badRequest('Schedule was not found.');
      if (action === 'resume' && schedule.lastError) throw badRequest('This schedule has a number conflict. Create a replacement with a new prefix.');
      const updated = { ...schedule, paused: action === 'pause' };
      await putReceiptJsonObject(`${prefix}recurrences/${id}.json`, updated);
      await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit(`recurrence.${action}d`, id, schedule.label, user.email));
      return jsonResponse(200, { success: true, schedule: updated });
    });
  } catch (error) { return failure(error); }
}
export async function recurrenceDailyHandler() {
  const user = await findUserByEmail(pilotEmail);
  if (!user || user.status !== 'active') return;
  await materializeRecurrences(`accounting/org-${user.organisationId}/`, new Date().toISOString().slice(0, 10));
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
    const closes = await vatCloses(prefix);
    return jsonResponse(200, { success: true, report, closes, filingPreview: buildVatFilingPreview(report, closes) });
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
    const requestId = String(data.requestId ?? '');
    if (requestId && !/^[0-9a-f-]{36}$/.test(requestId)) throw badRequest('Invalid email request ID.');
    const record: AccountingEmailRecord = { id: requestId || crypto.randomUUID(), documentId: document.id, recipient, kind: 'invoice', status: 'pending', requestedAt: new Date().toISOString() };
    const key = `${prefix}invoice-emails/${record.id}.json`;
    const prior = await optionalObject<AccountingEmailRecord>(key);
    if (prior) {
      if (prior.documentId !== document.id || prior.recipient !== recipient || prior.kind !== 'invoice') throw badRequest('Email request ID was already used for another invoice or recipient.');
      if (prior.status === 'pending' || prior.status === 'uncertain') throw badRequest('The previous email attempt has an uncertain status. Check the email activity before sending again.');
      return jsonResponse(200, { success: true, messageId: prior.messageId ?? null, alreadySent: true });
    }
    try { await putReceiptJsonObjectIfAbsent(key, record); }
    catch { throw badRequest('An email with this request ID is already being sent. Refresh before retrying.'); }
    let messageId: string | null;
    try { const settings = await optionalObject<AccountingReminderSettings>(`${prefix}reminder-settings.json`); messageId = await sendAccountingInvoice(document, recipient, { organisationId: user.organisationId, mailId: record.id }, settings?.replyToEmail); }
    catch (error) { await putReceiptJsonObject(key, { ...record, status: 'uncertain' }); throw error; }
    await withAccountingLock(prefix, async () => {
      const current = await getReceiptJsonObject<AccountingEmailRecord>(key);
      await putReceiptJsonObject(key, { ...current, status: current.status === 'pending' ? 'accepted' : current.status, acceptedAt: new Date().toISOString(), messageId: messageId ?? current.messageId });
    });
    await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('invoice.sent', document.id, `SES accepted ${document.number} for ${recipient}; message ${messageId ?? 'unknown'}`, user.email));
    return jsonResponse(200, { success: true, messageId });
  } catch (error) { return failure(error); }
}
export async function reminderSettingsHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const current = await optionalObject<AccountingReminderSettings>(`${prefix}reminder-settings.json`) ?? defaultReminderSettings;
      let settings: AccountingReminderSettings;
      if (data.action === 'exclude' || data.action === 'include') {
        const id = String(data.documentId ?? '');
        if (!/^[0-9a-f-]{36}$/.test(id)) throw badRequest('Choose a posted invoice.');
        const document = await optionalObject<AccountingDocument>(`${prefix}documents/${id}.json`);
        if (!document || document.kind !== 'invoice') throw badRequest('Choose a posted invoice.');
        settings = { ...current, excludedDocumentIds: data.action === 'exclude' ? [...new Set([...current.excludedDocumentIds, id])] : current.excludedDocumentIds.filter((item) => item !== id), updatedAt: new Date().toISOString(), updatedBy: user.email };
      } else {
        const days = data.days;
        const replyToEmail = String(data.replyToEmail ?? '').trim().toLowerCase();
        if (typeof data.enabled !== 'boolean' || !Array.isArray(days) || days.length < 1 || days.length > 5 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 90) || new Set(days).size !== days.length || replyToEmail.length > 254 || (replyToEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyToEmail)) || (data.enabled && !replyToEmail)) throw badRequest('Choose 1–5 distinct reminder days and a valid business reply-to email before enabling.');
        settings = { ...current, enabled: data.enabled, days: [...days].sort((a, b) => a - b) as number[], replyToEmail, updatedAt: new Date().toISOString(), updatedBy: user.email };
      }
      await putReceiptJsonObject(`${prefix}reminder-settings.json`, settings);
      await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('reminders.updated', 'settings', settings.enabled ? 'Automatic invoice reminders enabled or updated' : 'Automatic invoice reminders off', user.email));
      return jsonResponse(200, { success: true, settings });
    });
  } catch (error) { return failure(error); }
}
export async function reminderDailyHandler() {
  const user = await findUserByEmail(pilotEmail);
  if (!user || user.status !== 'active') return;
  const prefix = `accounting/org-${user.organisationId}/`;
  const settings = await optionalObject<AccountingReminderSettings>(`${prefix}reminder-settings.json`);
  if (!settings?.enabled) return;
  const today = new Date().toISOString().slice(0, 10);
  const books = await ledger(prefix);
  const deadline = Date.now() + 45_000;
  let sent = 0;
  for (const document of books.documents.filter((item) => item.kind === 'invoice')) {
    if (Date.now() >= deadline || sent >= 25) break;
    try {
      const sentOne = await withAccountingLock(prefix, async () => {
        const [freshSettings, freshBooks, records] = await Promise.all([optionalObject<AccountingReminderSettings>(`${prefix}reminder-settings.json`), ledger(prefix), load<AccountingEmailRecord>(`${prefix}invoice-emails/`)]);
        if (!freshSettings?.enabled) return false;
        const current = freshBooks.documents.find((item) => item.id === document.id);
        if (!current) return false;
        const row = buildAgingReport(today, freshBooks).receivables.rows.find((item) => item.documentId === current.id);
        const candidate = reminderCandidate(current, row, records, freshSettings, today);
        if (!candidate) return false;
        const record: AccountingEmailRecord = { id: crypto.randomUUID(), documentId: current.id, recipient: candidate.recipient, kind: 'reminder', milestoneDay: candidate.milestoneDay, status: 'pending', requestedAt: new Date().toISOString() };
        const key = `${prefix}invoice-emails/${record.id}.json`;
        await putReceiptJsonObjectIfAbsent(key, record);
        let messageId: string | null;
        try { messageId = await sendAccountingReminder(current, record.recipient, { organisationId: user.organisationId, mailId: record.id }, candidate.amountPence, freshSettings.replyToEmail); }
        catch (error) {
          await putReceiptJsonObject(key, { ...record, status: 'uncertain' });
          throw error;
        }
        await putReceiptJsonObject(key, { ...record, status: 'accepted', acceptedAt: new Date().toISOString(), messageId: messageId ?? undefined });
        await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('reminder.sent', current.id, `${current.number}: day ${candidate.milestoneDay}, GBP ${(candidate.amountPence / 100).toFixed(2)} to ${record.recipient}`, 'Accounting reminder schedule'));
        return true;
      });
      if (sentOne) sent += 1;
    } catch (error) {
      console.error('Accounting reminder attempt failed', document.id, error instanceof Error ? error.name : 'UnknownError');
    }
  }
}
type SesAccountingEvent = { source?: string; 'detail-type'?: string; detail?: { mail?: { messageId?: string; tags?: Record<string, string[]> } } };
export async function accountingEmailEventHandler(event: SesAccountingEvent) {
  if (event.source !== 'aws.ses') return;
  const statusByEvent: Record<string, AccountingEmailRecord['status']> = { 'Email Delivered': 'delivered', 'Email Bounced': 'bounced', 'Email Complaint Received': 'complained', 'Email Rejected': 'rejected', 'Email Delivery Delayed': 'delayed' };
  const status = statusByEvent[String(event['detail-type'] ?? '')];
  const orgId = event.detail?.mail?.tags?.accountingOrg?.[0] ?? '';
  const mailId = event.detail?.mail?.tags?.accountingMail?.[0] ?? '';
  if (!status || !/^\d+$/.test(orgId) || !/^[0-9a-f-]{36}$/.test(mailId)) return;
  const user = await findUserByEmail(pilotEmail);
  if (!user || user.status !== 'active' || String(user.organisationId) !== orgId) return;
  const prefix = `accounting/org-${orgId}/`;
  await withAccountingLock(prefix, async () => {
    const key = `${prefix}invoice-emails/${mailId}.json`;
    const current = await optionalObject<AccountingEmailRecord>(key);
    if (!current || (current.messageId && current.messageId !== event.detail?.mail?.messageId)) return;
    if (['bounced', 'complained', 'rejected'].includes(current.status) && !['bounced', 'complained', 'rejected'].includes(status)) return;
    if (current.status === 'delivered' && status === 'delayed') return;
    await putReceiptJsonObject(key, { ...current, status, messageId: current.messageId ?? event.detail?.mail?.messageId, ...(status === 'delivered' ? { deliveredAt: new Date().toISOString() } : {}) });
  });
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
    const [statements, matches, books, chart, feedTransactions, feedMatches, feedConnection] = await Promise.all([load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), ledger(prefix), accounts(prefix), load<BankFeedTransaction>(`${prefix}bank-feed/transactions/`), load<BankFeedMatch>(`${prefix}bank-feed/matches/`), optionalObject<BankFeedConnection>(feedConnectionKey(prefix))]);
    if (statements.some((item) => item.fromDate <= lock.lockedThrough && item.toDate > lock.lockedThrough)) throw badRequest('Close after the end of any imported statement that overlaps this date.');
    for (const statement of statements.filter((item) => item.toDate <= lock.lockedThrough)) {
      const matchedLines = matches.filter((item) => item.statementId === statement.id);
      const movements = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id)).filter((item) => item.accountId === (statement.accountId ?? '1000'));
      const bankBalance = movements.filter((item) => item.date <= statement.toDate).reduce((sum, item) => sum + item.amountPence, 0);
      const periodMovements = movements.filter((item) => item.date >= statement.fromDate && item.date <= statement.toDate);
      if (matchedLines.length !== statement.lines.length || periodMovements.some((item) => !matchedLines.some((match) => match.bankEntryId === item.id)) || bankBalance !== statement.closingPence) throw badRequest(`Reconcile ${statement.name} before closing this period.`);
    }
    if (feedTransactions.some((item) => item.date <= lock.lockedThrough && !feedMatches.some((match) => match.transactionId === item.id))) throw badRequest('Match all bank feed transactions through the closing date before locking this period.');
    if (feedConnection?.pending && feedConnection.pending.from <= lock.lockedThrough) throw badRequest('Finish the bank feed sync before locking this period.');
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
    const [matches, chart, feedMatches] = await Promise.all([load<BankMatch>(`${prefix}bank-matches/`), accounts(prefix), load<BankFeedMatch>(`${prefix}bank-feed/matches/`)]);
    const movementIds = new Set(bankEntries([original], chart.filter((item) => item.bank).map((item) => item.id)).map((item) => item.id));
    if (matches.some((item) => movementIds.has(item.bankEntryId))) throw badRequest('Unmatch this bank movement before reversing its entry.');
    if (feedMatches.some((item) => movementIds.has(item.bankEntryId))) throw badRequest('Unmatch this bank feed movement before reversing its entry.');
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
    if ((await load<BankFeedTransaction>(`${prefix}bank-feed/transactions/`)).some((row) => row.localAccountId === (statement.accountId ?? '1000') && row.date >= statement.fromDate && row.date <= statement.toDate)) throw badRequest('This date range contains bank feed transactions. Use the feed for these dates to avoid duplicate reconciliation lines.');
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

export async function bankFeedStatusHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix } = await scope(event);
    let connection = await optionalObject<BankFeedConnection>(feedConnectionKey(prefix));
    if (bankFeedConfigured() && connection?.authorization) {
      try {
        const authorizedAccounts = await connectedAccounts(connection.authorization.id, sourceIp(event));
        if (!authorizedAccounts.length) throw new Error('Bank authorisation is not complete.');
        connection = await withAccountingLock(prefix, async () => {
          const latest = await optionalObject<BankFeedConnection>(feedConnectionKey(prefix));
          if (!latest?.authorization || latest.authorization.id !== connection?.authorization?.id) return latest;
          const promoted = { ...latest, id: latest.authorization.id, connectedAt: new Date().toISOString(), accounts: [], pending: undefined, authorization: undefined };
          await putReceiptJsonObject(feedConnectionKey(prefix), promoted);
          return promoted;
        });
      } catch { /* Consent is still in progress or was declined; retain the previous connection. */ }
    }
    if (!bankFeedConfigured() || !connection || connection.environment !== bankFeedEnvironment() || !connection.id) return jsonResponse(200, { success: true, configured: bankFeedConfigured(), environment: bankFeedEnvironment(), connectionState: connection?.authorization ? 'authorization_pending' : connection ? 'reconnect_required' : 'not_connected', accounts: [], mappings: connection?.accounts ?? [], pending: Boolean(connection?.pending), pendingRequest: connection?.pending });
    try {
      const available = await connectedAccounts(connection.id, sourceIp(event));
      return jsonResponse(200, { success: true, configured: true, environment: bankFeedEnvironment(), connectionState: 'connected', accounts: available.filter((item) => item.currency === 'GBP'), mappings: connection.accounts, pending: Boolean(connection.pending), pendingRequest: connection.pending });
    } catch (error) {
      const status = (error as { providerStatus?: number }).providerStatus;
      return jsonResponse(200, { success: true, configured: true, environment: bankFeedEnvironment(), connectionState: status === 401 || status === 403 ? 'reconnect_required' : 'temporarily_unavailable', accounts: [], mappings: connection.accounts, pending: Boolean(connection.pending), pendingRequest: connection.pending });
    }
  } catch (error) { return failure(error); }
}

export async function bankFeedConnectHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    if (!bankFeedConfigured()) throw badRequest('Bank feed provider credentials are not configured.');
    const connection = await createDataConnection(user.fullName || 'Exdox owner', user.email, sourceIp(event));
    await withAccountingLock(prefix, async () => {
      const existing = await optionalObject<BankFeedConnection>(feedConnectionKey(prefix));
      await putReceiptJsonObject(feedConnectionKey(prefix), { provider: 'truelayer', environment: bankFeedEnvironment(), id: existing?.id ?? '', connectedAt: existing?.connectedAt ?? '', connectedBy: user.id, accounts: existing?.accounts ?? [], pending: existing?.pending, authorization: { id: connection.id, createdAt: new Date().toISOString() } } satisfies BankFeedConnection);
    });
    return jsonResponse(200, { success: true, authorizationUrl: connection.url });
  } catch (error) { return failure(error); }
}

export async function bankFeedSyncHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const remoteId = String(data.remoteAccountId ?? '');
      const localId = String(data.localAccountId ?? '');
      const from = String(data.from ?? '');
      const to = String(data.to ?? '');
      if (!/^[0-9a-f-]{32,36}$/i.test(remoteId) || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`)) || from > to || to > new Date().toISOString().slice(0, 10) || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 90 * 86400000) throw badRequest('Choose a bank account and a date range of up to 90 days.');
      await assertBankAccount(prefix, localId);
      const connection = await optionalObject<BankFeedConnection>(feedConnectionKey(prefix));
      if (!connection || connection.environment !== bankFeedEnvironment()) throw badRequest('Connect a bank feed first.');
      const remoteAccounts = await connectedAccounts(connection.id, sourceIp(event));
      if (!remoteAccounts.some((item) => item.id === remoteId && item.currency === 'GBP')) throw badRequest('Choose a connected GBP bank account.');
      if (connection.accounts.some((item) => item.remoteId === remoteId && item.localId !== localId)) throw badRequest('This bank is already linked to a different accounting bank account.');
      if (connection.accounts.some((item) => item.localId === localId && item.remoteId !== remoteId)) throw badRequest('This accounting bank account is already linked to a different connected bank.');
      const statements = await load<BankStatement>(`${prefix}bank-statements/`);
      if (statements.some((item) => (item.accountId ?? '1000') === localId && from <= item.toDate && to >= item.fromDate)) throw badRequest('This date range overlaps a manually imported statement. Start after the last CSV statement to avoid duplicates.');
      const existing = await load<BankFeedTransaction>(`${prefix}bank-feed/transactions/`);
      if (existing.some((item) => item.localAccountId === localId && item.connectionId !== connection.id && item.date >= from && item.date <= to)) throw badRequest('This range overlaps transactions from an earlier bank connection. Start after those transactions to avoid duplicates.');
      const pending = connection.pending;
      if (pending && (pending.remoteId !== remoteId || pending.localId !== localId || pending.from !== from || pending.to !== to)) throw badRequest('Finish the current bank feed request before starting another.');
      if (!pending) {
        const requestId = await startTransactions(connection.id, remoteId, from, to, undefined, sourceIp(event));
        connection.pending = { remoteId, localId, from, to, requestId };
        await putReceiptJsonObject(feedConnectionKey(prefix), connection);
        return jsonResponse(202, { success: true, status: 'pending', imported: 0 });
      }
      const result = await readTransactions(connection.id, remoteId, pending.requestId, sourceIp(event));
      if (result.status === 'pending') return jsonResponse(202, { success: true, status: 'pending', imported: 0 });
      if (result.status === 'failed') { delete connection.pending; await putReceiptJsonObject(feedConnectionKey(prefix), connection); throw badRequest('The bank could not return transactions. Try the sync again.'); }
      const normalized = result.items.map((item) => normalizeFeedTransaction(item, connection.id, remoteId, localId)).filter((item): item is BankFeedTransaction => item !== null);
      if (new Set(normalized.map((item) => item.id)).size !== normalized.length) throw badRequest('Bank feed returned duplicate transaction identifiers. No rows were imported.');
      if (normalized.some((item) => item.date < from || item.date > to)) throw badRequest('Bank feed returned a transaction outside the requested dates. No rows were imported.');
      if (existing.some((item) => item.remoteAccountId === remoteId && item.localAccountId !== localId)) throw badRequest('This connected bank already belongs to another accounting bank account.');
      const known = new Set(existing.map((item) => item.id));
      const newRows = normalized.filter((row) => !known.has(row.id));
      for (const item of newRows) await putReceiptJsonObjectIfAbsent(`${prefix}bank-feed/transactions/${item.id}.json`, item);
      if (newRows.length) await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.feed_imported', remoteId, `${newRows.length} settled GBP transactions imported for ${from} to ${to}`, user.email));
      const mapping = connection.accounts.find((item) => item.remoteId === remoteId);
      if (mapping) mapping.lastSyncedAt = new Date().toISOString();
      else connection.accounts.push({ remoteId, localId, label: remoteAccounts.find((item) => item.id === remoteId)?.label ?? 'Connected bank', lastSyncedAt: new Date().toISOString() });
      if (result.nextCursor) {
        connection.pending = { remoteId, localId, from, to, cursor: result.nextCursor, requestId: await startTransactions(connection.id, remoteId, from, to, result.nextCursor, sourceIp(event)) };
      } else delete connection.pending;
      await putReceiptJsonObject(feedConnectionKey(prefix), connection);
      return jsonResponse(result.nextCursor ? 202 : 200, { success: true, status: result.nextCursor ? 'pending' : 'complete', imported: newRows.length });
    });
  } catch (error) { return failure(error); }
}

export async function bankFeedMatchHandler(event: APIGatewayProxyEventV2) {
  try {
    const { prefix, user } = await scope(event);
    return await withAccountingLock(prefix, async () => {
      const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
      const transactionId = String(data.transactionId ?? '');
      const bankEntryId = String(data.bankEntryId ?? '');
      if (!/^[0-9a-f]{64}$/.test(transactionId)) throw badRequest('Choose a bank feed transaction.');
      const transaction = await optionalObject<BankFeedTransaction>(`${prefix}bank-feed/transactions/${transactionId}.json`);
      if (!transaction) throw badRequest('Bank feed transaction not found.');
      const matchKey = `${prefix}bank-feed/matches/${transactionId}.json`;
      const existing = await optionalObject<BankFeedMatch>(matchKey);
      if ((event.requestContext?.http?.method ?? (event as APIGatewayProxyEventV2 & { httpMethod?: string }).httpMethod ?? 'POST').toUpperCase() === 'DELETE') {
        if (!existing) throw badRequest('This bank feed transaction is not matched.');
        assertOpenPeriod(transaction.date, await currentLock(prefix));
        await deleteReceiptObject(matchKey);
        await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.feed_unmatched', transactionId, existing.bankEntryId, user.email));
        return jsonResponse(200, { success: true });
      }
      if (existing) throw badRequest('This bank feed transaction is already matched.');
      const [books, chart, statementMatches, feedMatches] = await Promise.all([ledger(prefix), accounts(prefix), load<BankMatch>(`${prefix}bank-matches/`), load<BankFeedMatch>(`${prefix}bank-feed/matches/`)]);
      const movement = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id)).find((item) => item.id === bankEntryId);
      if (!movement || movement.accountId !== transaction.localAccountId || movement.amountPence !== transaction.amountPence) throw badRequest('Choose a ledger movement in the same bank account for the exact amount.');
      if (statementMatches.some((item) => item.bankEntryId === bankEntryId) || feedMatches.some((item) => item.bankEntryId === bankEntryId)) throw badRequest('That ledger movement is already matched.');
      assertOpenPeriod(transaction.date, await currentLock(prefix));
      assertOpenPeriod(movement.date, await currentLock(prefix));
      const match = { transactionId, bankEntryId, matchedAt: new Date().toISOString(), matchedBy: user.email } satisfies BankFeedMatch;
      await putReceiptJsonObjectIfAbsent(matchKey, match);
      await putReceiptJsonObject(`${prefix}audit/${crypto.randomUUID()}.json`, createAudit('bank.feed_matched', transactionId, bankEntryId, user.email));
      return jsonResponse(201, { success: true, match });
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
      const samePosting = (entry: JournalEntry) => entry.date === journal.date && entry.reference === journal.reference && entry.description === journal.description && JSON.stringify(entry.lines) === JSON.stringify(journal.lines);
      const existingMatch = existingMatches.find((item) => item.statementId === statement.id && item.lineIndex === line.index);
      if (existingMatch) {
        if (existingMatch.bankEntryId === `${journal.id}:0` || existingMatch.bankEntryId === `${journal.id}:1`) {
          const posted = await getReceiptJsonObject<JournalEntry>(`${prefix}journals/${journal.id}.json`);
          if (!samePosting(posted)) throw badRequest('This line was posted with a different bank rule. Refresh before continuing.');
          return jsonResponse(200, { success: true, entry: posted, match: existingMatch, alreadyPosted: true });
        }
        throw badRequest('This statement line is already matched.');
      }
      if (books.reversals.some((item) => item.targetEntryId === journal.id)) throw badRequest('This rule journal was reversed. Review the statement line before posting again.');
      const bankMovement = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id));
      const ruleBankEntryId = bankEntries([journal], [statement.accountId ?? '1000'])[0]?.id;
      if (likelyExistingBankMovement(line, statement.accountId ?? '1000', bankMovement, existingMatches, ruleBankEntryId)) throw badRequest('A similar unmatched bank ledger movement already exists. Review and match it before posting a rule journal.');
      try { assertOpenPeriod(journal.date, await currentLock(prefix)); assertVatOpen(journal.date, await vatCloses(prefix)); }
      catch (error) { throw badRequest(error instanceof Error ? error.message : 'Period is locked.'); }
      const journalKey = `${prefix}journals/${journal.id}.json`;
      let posted = journal;
      try { await putReceiptJsonObjectIfAbsent(journalKey, journal); }
      catch (error) {
        const status = typeof error === 'object' && error !== null && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
        if (status !== 412) throw error;
        posted = await getReceiptJsonObject<JournalEntry>(journalKey);
        if (!samePosting(posted)) throw badRequest('This line was already posted with a different bank rule. Refresh before continuing.');
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
    const [statements, matches, books, chart, feedMatches] = await Promise.all([load<BankStatement>(`${prefix}bank-statements/`), load<BankMatch>(`${prefix}bank-matches/`), ledger(prefix), accounts(prefix), load<BankFeedMatch>(`${prefix}bank-feed/matches/`)]);
    const movements = bankEntries(books.entries, chart.filter((item) => item.bank).map((item) => item.id));
    let match: BankMatch;
    try { match = createBankMatch(data, statements, movements, matches, user.email); } catch (error) { throw badRequest(error instanceof Error ? error.message : 'Invalid match.'); }
    if (feedMatches.some((item) => item.bankEntryId === match.bankEntryId)) throw badRequest('This ledger movement is already matched to a bank feed transaction.');
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
