import { randomUUID } from 'node:crypto';
import { createDocument, type AccountingDocument, type JournalEntry } from './accounting.js';
import { validBookDate } from './accountingSafeguards.js';

export type AccountingContact = { id: string; version: number; role: 'customer' | 'supplier' | 'both'; name: string; email: string; address: string; updatedAt: string; updatedBy: string };
export type AccountingDraft = { id: string; version: number; contactId: string; document: Omit<AccountingDocument, 'id' | 'createdAt' | 'createdBy'>; updatedAt: string; updatedBy: string };
export type AccountingAudit = { id: string; action: string; subjectId: string; detail: string; at: string; by: string };
export type AccountingSettlement = { id: string; kind: 'invoice' | 'bill'; date: string; reference: string; allocations: Array<{ documentId: string; amountPence: number }>; totalPence: number; createdAt: string; createdBy: string };
export type AccountingRefund = { id: string; creditId: string; date: string; reference: string; amountPence: number; createdAt: string; createdBy: string };

export function accountingInvoiceText(document: AccountingDocument) {
  const pounds = (pence: number) => `GBP ${(pence / 100).toFixed(2)}`;
  return [
    `${document.issuerName}\n${document.issuerAddress}`,
    `Invoice ${document.number}`,
    `Customer: ${document.contactName}\n${document.contactAddress}`,
    `Issue date: ${document.date}`,
    `VAT tax date: ${document.taxDate || document.date}`,
    `Due date: ${document.dueDate}`,
    document.vatNumber ? `VAT number: ${document.vatNumber}` : '',
    ...document.items.map((item) => `${item.description}: ${item.quantity} × ${pounds(item.unitPricePence)}; VAT ${item.vatRate}%; net ${pounds(item.quantity * item.unitPricePence)}`),
    `Net: ${pounds(document.netPence)}\nVAT: ${pounds(document.vatPence)}\nTotal: ${pounds(document.totalPence)}`,
    document.paymentInstructions ? `Payment instructions:\n${document.paymentInstructions}` : '',
  ].filter(Boolean).join('\n\n');
}

export function latestVersions<T extends { id: string; version: number }>(records: T[]): T[] {
  const latest = new Map<string, T>();
  for (const item of records) if (!latest.has(item.id) || latest.get(item.id)!.version < item.version) latest.set(item.id, item);
  return [...latest.values()];
}
export function createContact(input: unknown, by: string, prior?: AccountingContact): AccountingContact {
  const data = input as Record<string, unknown>;
  const name = String(data?.name ?? '').trim();
  const email = String(data?.email ?? '').trim().toLowerCase();
  const address = String(data?.address ?? '').trim();
  const role = data?.role;
  if (name.length < 2 || name.length > 120 || (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) || email.length > 254 || address.length > 500 || !['customer', 'supplier', 'both'].includes(String(role))) throw new Error('Enter a contact name, valid optional email, address and type.');
  return { id: prior?.id ?? randomUUID(), version: (prior?.version ?? 0) + 1, role: role as AccountingContact['role'], name, email, address, updatedAt: new Date().toISOString(), updatedBy: by };
}
export function createDraft(input: unknown, by: string, prior?: AccountingDraft): AccountingDraft {
  const data = input as Record<string, unknown>;
  const validated = createDocument(data, by);
  return { id: prior?.id ?? randomUUID(), version: (prior?.version ?? 0) + 1, contactId: String(data.contactId ?? ''), document: (({ id, createdAt, createdBy, ...rest }) => rest)(validated), updatedAt: new Date().toISOString(), updatedBy: by };
}
export function approveDraft(draft: AccountingDraft, by: string): AccountingDocument {
  return { ...draft.document, id: draft.id, draftId: draft.id, contactId: draft.contactId || undefined, createdAt: new Date().toISOString(), createdBy: by };
}
export function createAudit(action: string, subjectId: string, detail: string, by: string): AccountingAudit {
  return { id: randomUUID(), action, subjectId, detail, at: new Date().toISOString(), by };
}
export function createSettlement(input: unknown, documents: AccountingDocument[], due: (id: string) => number, by: string): AccountingSettlement {
  const data = input as Record<string, unknown>;
  const kind = data.kind;
  const date = String(data.date ?? '');
  const reference = String(data.reference ?? '').trim();
  if (!['invoice', 'bill'].includes(String(kind)) || !validBookDate(date) || reference.length > 80 || !Array.isArray(data.allocations) || !data.allocations.length || data.allocations.length > 50) throw new Error('Enter a valid settlement type, date, and allocations.');
  const seen = new Set<string>();
  const allocations = data.allocations.map((raw: unknown) => {
    const row = raw as Record<string, unknown>;
    const documentId = String(row.documentId ?? '');
    const amountPence = Number(row.amountPence);
    const document = documents.find((item) => item.id === documentId);
    if (!document || document.kind !== kind || seen.has(documentId) || date < document.date || !Number.isSafeInteger(amountPence) || amountPence <= 0 || amountPence > due(documentId)) throw new Error('Each allocation needs an unpaid document and an amount no higher than its balance.');
    seen.add(documentId);
    return { documentId, amountPence };
  });
  const totalPence = allocations.reduce((sum, item) => sum + item.amountPence, 0);
  if (!Number.isSafeInteger(totalPence) || totalPence <= 0) throw new Error('Settlement total must be positive.');
  return { id: randomUUID(), kind: kind as AccountingSettlement['kind'], date, reference, allocations, totalPence, createdAt: new Date().toISOString(), createdBy: by };
}
export function settlementJournal(item: AccountingSettlement): JournalEntry {
  const invoice = item.kind === 'invoice';
  return { id: `settlement-${item.id}`, date: item.date, reference: item.reference, description: `${invoice ? 'Receipt' : 'Payment'} allocated to ${item.allocations.length} document(s)`, lines: invoice ? [
    { accountId: '1000', debitPence: item.totalPence, creditPence: 0 }, { accountId: '1100', debitPence: 0, creditPence: item.totalPence },
  ] : [{ accountId: '2000', debitPence: item.totalPence, creditPence: 0 }, { accountId: '1000', debitPence: 0, creditPence: item.totalPence }], createdAt: item.createdAt, createdBy: item.createdBy };
}
export function createRefund(input: unknown, maxPence: number, by: string): AccountingRefund {
  const data = input as Record<string, unknown>;
  const creditId = String(data.creditId ?? '');
  const date = String(data.date ?? '');
  const reference = String(data.reference ?? '').trim();
  const amountPence = Number(data.amountPence);
  if (!/^[0-9a-f-]{36}$/.test(creditId) || !validBookDate(date) || !Number.isSafeInteger(amountPence) || amountPence <= 0 || amountPence > maxPence || reference.length > 80) throw new Error('Enter a valid refund date and amount within the refundable balance.');
  return { id: randomUUID(), creditId, date, reference, amountPence, createdAt: new Date().toISOString(), createdBy: by };
}
export function refundJournal(refund: AccountingRefund, invoice: boolean): JournalEntry {
  return { id: `refund-${refund.id}`, date: refund.date, reference: refund.reference, description: `${invoice ? 'Customer' : 'Supplier'} refund for credit note`, lines: invoice ? [
    { accountId: '1100', debitPence: refund.amountPence, creditPence: 0 }, { accountId: '1000', debitPence: 0, creditPence: refund.amountPence },
  ] : [{ accountId: '1000', debitPence: refund.amountPence, creditPence: 0 }, { accountId: '2000', debitPence: 0, creditPence: refund.amountPence }], createdAt: refund.createdAt, createdBy: refund.createdBy };
}
