import { randomUUID } from 'node:crypto';
import { validVatDate, validateVatCode, type VatCode } from './accountingVat.js';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type LedgerAccount = { id: string; code: string; name: string; type: AccountType; system?: boolean };
export type JournalLine = { accountId: string; debitPence: number; creditPence: number };
export type JournalEntry = { id: string; date: string; reference: string; description: string; lines: JournalLine[]; createdAt: string; createdBy: string };
export type AccountingDocument = { id: string; draftId?: string; contactId?: string; kind: 'invoice' | 'bill'; number: string; contactName: string; issuerName: string; issuerAddress: string; contactAddress: string; vatNumber: string; paymentInstructions: string; date: string; taxDate?: string; dueDate: string; items: Array<{ description: string; quantity: number; unitPricePence: number; vatRate: 0 | 5 | 20; vatCode?: VatCode }>; netPence: number; vatPence: number; totalPence: number; createdAt: string; createdBy: string };
export type AccountingPayment = { id: string; documentId: string; date: string; amountPence: number; reference: string; createdAt: string; createdBy: string };

export const defaultAccounts: LedgerAccount[] = [
  { id: '1000', code: '1000', name: 'Bank', type: 'asset', system: true },
  { id: '1100', code: '1100', name: 'Accounts receivable', type: 'asset', system: true },
  { id: '1200', code: '1200', name: 'VAT receivable', type: 'asset', system: true },
  { id: '2000', code: '2000', name: 'Accounts payable', type: 'liability', system: true },
  { id: '2100', code: '2100', name: 'VAT payable', type: 'liability', system: true },
  { id: '3000', code: '3000', name: 'Owner capital', type: 'equity', system: true },
  { id: '3100', code: '3100', name: 'Retained earnings', type: 'equity', system: true },
  { id: '4000', code: '4000', name: 'Sales', type: 'income', system: true },
  { id: '5000', code: '5000', name: 'Cost of sales', type: 'expense', system: true },
  { id: '6000', code: '6000', name: 'Operating expenses', type: 'expense', system: true },
];

export function createAccount(input: unknown, existing: LedgerAccount[]): LedgerAccount {
  const data = input as Record<string, unknown>;
  const code = String(data?.code ?? '').trim();
  const name = String(data?.name ?? '').trim();
  const type = data?.type;
  if (!/^\d{4,6}$/.test(code) || name.length < 2 || name.length > 100 || !['asset', 'liability', 'equity', 'income', 'expense'].includes(String(type))) {
    throw new Error('Enter a 4–6 digit code, a name, and a valid account type.');
  }
  if (existing.some((account) => account.code === code)) throw new Error('That account code already exists.');
  return { id: randomUUID(), code, name, type: type as AccountType };
}

export function createJournal(input: unknown, accounts: LedgerAccount[], createdBy: string): JournalEntry {
  const data = input as Record<string, unknown>;
  const date = String(data?.date ?? '');
  const description = String(data?.description ?? '').trim();
  const reference = String(data?.reference ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || description.length < 3 || description.length > 240 || reference.length > 80) {
    throw new Error('Enter a valid date and a description of 3–240 characters.');
  }
  if (!Array.isArray(data?.lines) || data.lines.length < 2 || data.lines.length > 50) throw new Error('A journal needs 2–50 lines.');
  const allowed = new Set(accounts.map((account) => account.id));
  const lines = data.lines.map((raw: unknown) => {
    const line = raw as Record<string, unknown>;
    const accountId = String(line?.accountId ?? '');
    const debitPence = Number(line?.debitPence ?? 0);
    const creditPence = Number(line?.creditPence ?? 0);
    if (!allowed.has(accountId) || !Number.isSafeInteger(debitPence) || !Number.isSafeInteger(creditPence) || debitPence < 0 || creditPence < 0 || (debitPence > 0) === (creditPence > 0)) {
      throw new Error('Each line needs one valid account and exactly one positive debit or credit.');
    }
    return { accountId, debitPence, creditPence };
  });
  const debits = lines.reduce((sum, line) => sum + line.debitPence, 0);
  const credits = lines.reduce((sum, line) => sum + line.creditPence, 0);
  if (!Number.isSafeInteger(debits) || debits === 0 || debits !== credits) throw new Error('Debits and credits must balance exactly.');
  return { id: randomUUID(), date, reference, description, lines, createdAt: new Date().toISOString(), createdBy };
}

export function createDocument(input: unknown, createdBy: string): AccountingDocument {
  const data = input as Record<string, unknown>;
  const kind = data?.kind;
  const number = String(data?.number ?? '').trim();
  const contactName = String(data?.contactName ?? '').trim();
  const issuerName = String(data?.issuerName ?? '').trim();
  const issuerAddress = String(data?.issuerAddress ?? '').trim();
  const contactAddress = String(data?.contactAddress ?? '').trim();
  const vatNumber = String(data?.vatNumber ?? '').trim();
  const paymentInstructions = String(data?.paymentInstructions ?? '').trim();
  const date = String(data?.date ?? '');
  const taxDate = String(data?.taxDate ?? date);
  const dueDate = String(data?.dueDate ?? '');
  const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if ((kind !== 'invoice' && kind !== 'bill') || !number || number.length > 80 || contactName.length < 2 || contactName.length > 120 || !validDate(date) || !validDate(dueDate) || !validVatDate(taxDate) || dueDate < date) throw new Error('Enter a document type, number, contact, issue date, VAT tax date, and valid due date.');
  if (kind === 'invoice' && (!issuerName || !issuerAddress || !contactAddress)) throw new Error('A printable invoice needs your business name and address and the customer address.');
  if ([issuerName, issuerAddress, contactAddress, vatNumber, paymentInstructions].some((value) => value.length > 500)) throw new Error('Invoice details must be 500 characters or fewer.');
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 50) throw new Error('Add 1–50 line items.');
  const items = data.items.map((raw: unknown) => {
    const line = raw as Record<string, unknown>;
    const description = String(line?.description ?? '').trim();
    const quantity = Number(line?.quantity);
    const unitPricePence = Number(line?.unitPricePence);
    const vatRate = Number(line?.vatRate);
    if (!description || description.length > 200 || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100000 || !Number.isSafeInteger(unitPricePence) || unitPricePence < 0 || unitPricePence > 100000000 || ![0, 5, 20].includes(vatRate)) throw new Error('Line items need a description, whole quantity, price, and 0%, 5%, or 20% VAT.');
    const vatCode = validateVatCode(line?.vatCode, kind as 'invoice' | 'bill', vatRate as 0 | 5 | 20);
    return { description, quantity, unitPricePence, vatRate: vatRate as 0 | 5 | 20, vatCode };
  });
  const netPence = items.reduce((sum, item) => sum + item.quantity * item.unitPricePence, 0);
  const vatPence = items.reduce((sum, item) => sum + Math.round(item.quantity * item.unitPricePence * item.vatRate / 100), 0);
  const totalPence = netPence + vatPence;
  if (kind === 'invoice' && vatPence > 0 && !vatNumber) throw new Error('Enter your VAT number before charging VAT on an invoice.');
  if (!Number.isSafeInteger(totalPence) || totalPence <= 0) throw new Error('Document total must be positive.');
  return { id: randomUUID(), kind, number, contactName, issuerName, issuerAddress, contactAddress, vatNumber, paymentInstructions, date, taxDate, dueDate, items, netPence, vatPence, totalPence, createdAt: new Date().toISOString(), createdBy };
}

export function documentJournal(document: AccountingDocument): JournalEntry {
  const invoice = document.kind === 'invoice';
  const lines = invoice ? [
    { accountId: '1100', debitPence: document.totalPence, creditPence: 0 },
    { accountId: '4000', debitPence: 0, creditPence: document.netPence },
    ...(document.vatPence ? [{ accountId: '2100', debitPence: 0, creditPence: document.vatPence }] : []),
  ] : [
    { accountId: '6000', debitPence: document.netPence, creditPence: 0 },
    ...(document.vatPence ? [{ accountId: '1200', debitPence: document.vatPence, creditPence: 0 }] : []),
    { accountId: '2000', debitPence: 0, creditPence: document.totalPence },
  ];
  return { id: `document-${document.id}`, date: document.date, reference: document.number, description: `${invoice ? 'Invoice to' : 'Bill from'} ${document.contactName}`, lines, createdAt: document.createdAt, createdBy: document.createdBy };
}

export function createPayment(input: unknown, document: AccountingDocument, existing: AccountingPayment[], createdBy: string, creditedPence = 0): AccountingPayment {
  const data = input as Record<string, unknown>;
  const date = String(data?.date ?? '');
  const amountPence = Number(data?.amountPence);
  const reference = String(data?.reference ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || date < document.date || !Number.isSafeInteger(amountPence) || amountPence <= 0 || reference.length > 80) throw new Error('Enter a valid payment date and positive amount.');
  const remaining = document.totalPence - creditedPence - existing.reduce((sum, payment) => sum + payment.amountPence, 0);
  if (amountPence > remaining) throw new Error('Payment exceeds the amount due.');
  return { id: randomUUID(), documentId: document.id, date, amountPence, reference, createdAt: new Date().toISOString(), createdBy };
}

export function paymentJournal(payment: AccountingPayment, document: AccountingDocument): JournalEntry {
  const invoice = document.kind === 'invoice';
  return { id: `payment-${payment.id}`, date: payment.date, reference: payment.reference || document.number, description: `${invoice ? 'Received payment for' : 'Paid'} ${document.number}`, lines: invoice ? [
    { accountId: '1000', debitPence: payment.amountPence, creditPence: 0 },
    { accountId: '1100', debitPence: 0, creditPence: payment.amountPence },
  ] : [
    { accountId: '2000', debitPence: payment.amountPence, creditPence: 0 },
    { accountId: '1000', debitPence: 0, creditPence: payment.amountPence },
  ], createdAt: payment.createdAt, createdBy: payment.createdBy };
}

export function ledgerReport(accounts: LedgerAccount[], entries: JournalEntry[], through?: string) {
  const selected = through ? entries.filter((entry) => entry.date <= through) : entries;
  const balances = accounts.map((account) => {
    const debitPence = selected.reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountId === account.id).reduce((total, line) => total + line.debitPence, 0), 0);
    const creditPence = selected.reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountId === account.id).reduce((total, line) => total + line.creditPence, 0), 0);
    return { ...account, debitPence, creditPence, balancePence: debitPence - creditPence };
  });
  const net = (type: AccountType) => balances.filter((account) => account.type === type).reduce((sum, account) => sum + account.balancePence, 0);
  const profitPence = -net('income') - net('expense');
  return { balances, profitPence, assetsPence: net('asset'), liabilitiesPence: -net('liability'), equityPence: -net('equity') + profitPence, journalCount: selected.length };
}
