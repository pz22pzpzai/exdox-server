import { randomUUID } from 'node:crypto';
import type { AccountingDocument, AccountingPayment, JournalEntry, JournalLine } from './accounting.js';

export type PeriodLock = { id: string; lockedThrough: string; reason: string; createdAt: string; createdBy: string };
export type Reversal = { targetEntryId: string; date: string; reason: string; createdAt: string; createdBy: string };
export type CreditNote = { id: string; documentId: string; number: string; date: string; reason: string; items: Array<{ itemIndex: number; quantity: number }>; netPence: number; vatPence: number; totalPence: number; createdAt: string; createdBy: string };

export function validBookDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function lockedThrough(events: PeriodLock[]) {
  return events.reduce<string | null>((latest, event) => !latest || event.lockedThrough > latest ? event.lockedThrough : latest, null);
}
export function assertOpenPeriod(date: string, through: string | null) {
  if (!validBookDate(date)) throw new Error('Enter a valid accounting date.');
  if (through && date <= through) throw new Error(`Accounting is locked through ${through}. Post an adjustment in an open period.`);
}
export function createPeriodLock(input: unknown, events: PeriodLock[], createdBy: string): PeriodLock {
  const data = input as Record<string, unknown>;
  const date = String(data?.lockedThrough ?? '');
  const reason = String(data?.reason ?? '').trim();
  if (!validBookDate(date) || date > new Date().toISOString().slice(0, 10) || reason.length < 3 || reason.length > 240) throw new Error('Choose a past or current date and give a reason for closing the period.');
  const existing = lockedThrough(events);
  if (existing && date <= existing) throw new Error(`Books are already locked through ${existing}. Choose a later date.`);
  return { id: randomUUID(), lockedThrough: date, reason, createdAt: new Date().toISOString(), createdBy };
}
export function createReversal(input: unknown, entry: JournalEntry, existing: Reversal[], through: string | null, createdBy: string): Reversal {
  const data = input as Record<string, unknown>;
  const date = String(data?.date ?? '');
  const reason = String(data?.reason ?? '').trim();
  assertOpenPeriod(date, through);
  if (reason.length < 5 || reason.length > 240) throw new Error('Explain the correction in 5–240 characters.');
  if (entry.id.startsWith('reversal-')) throw new Error('Reverse the original entry through a new correcting journal.');
  if (existing.some((item) => item.targetEntryId === entry.id)) throw new Error('This entry has already been reversed.');
  return { targetEntryId: entry.id, date, reason, createdAt: new Date().toISOString(), createdBy };
}
export function reversalJournal(reversal: Reversal, original: JournalEntry): JournalEntry {
  return { id: `reversal-${original.id}`, date: reversal.date, reference: original.reference, description: `Reversal: ${reversal.reason}`, lines: original.lines.map((line: JournalLine) => ({ accountId: line.accountId, debitPence: line.creditPence, creditPence: line.debitPence })), createdAt: reversal.createdAt, createdBy: reversal.createdBy };
}
export function createCreditNote(input: unknown, document: AccountingDocument, existing: CreditNote[], payments: AccountingPayment[], through: string | null, createdBy: string): CreditNote {
  const data = input as Record<string, unknown>;
  const number = String(data?.number ?? '').trim();
  const date = String(data?.date ?? '');
  const reason = String(data?.reason ?? '').trim();
  assertOpenPeriod(date, through);
  if (date < document.date || !number || number.length > 80 || reason.length < 5 || reason.length > 240) throw new Error('Enter a credit note number, valid date, and correction reason.');
  if (!Array.isArray(data?.items) || !data.items.length || data.items.length > document.items.length) throw new Error('Select at least one original line to credit.');
  const seen = new Set<number>();
  const items = data.items.map((value: unknown) => {
    const item = value as Record<string, unknown>;
    const itemIndex = Number(item?.itemIndex);
    const quantity = Number(item?.quantity);
    const original = document.items[itemIndex];
    if (!Number.isSafeInteger(itemIndex) || !original || seen.has(itemIndex) || !Number.isSafeInteger(quantity) || quantity <= 0) throw new Error('Credit quantities must refer to distinct original lines.');
    seen.add(itemIndex);
    const alreadyCredited = existing.flatMap((credit) => credit.items).filter((line) => line.itemIndex === itemIndex).reduce((sum, line) => sum + line.quantity, 0);
    if (quantity + alreadyCredited > original.quantity) throw new Error('Credit quantity exceeds the original item quantity.');
    return { itemIndex, quantity };
  });
  const netPence = items.reduce((sum, item) => sum + item.quantity * document.items[item.itemIndex].unitPricePence, 0);
  const vatPence = items.reduce((sum, item) => {
    const original = document.items[item.itemIndex];
    const previousQuantity = existing.flatMap((credit) => credit.items).filter((line) => line.itemIndex === item.itemIndex).reduce((total, line) => total + line.quantity, 0);
    const vatAt = (quantity: number) => Math.round(quantity * original.unitPricePence * original.vatRate / 100);
    return sum + vatAt(previousQuantity + item.quantity) - vatAt(previousQuantity);
  }, 0);
  const totalPence = netPence + vatPence;
  const paidPence = payments.reduce((sum, payment) => sum + payment.amountPence, 0);
  const creditedPence = existing.reduce((sum, credit) => sum + credit.totalPence, 0);
  if (!Number.isSafeInteger(totalPence) || totalPence <= 0 || totalPence > document.totalPence - paidPence - creditedPence) throw new Error('Credit exceeds the unpaid balance. Record any refund separately before crediting a paid document.');
  return { id: randomUUID(), documentId: document.id, number, date, reason, items, netPence, vatPence, totalPence, createdAt: new Date().toISOString(), createdBy };
}
export function creditJournal(credit: CreditNote, document: AccountingDocument): JournalEntry {
  const invoice = document.kind === 'invoice';
  const lines = invoice ? [
    { accountId: '4000', debitPence: credit.netPence, creditPence: 0 },
    ...(credit.vatPence ? [{ accountId: '2100', debitPence: credit.vatPence, creditPence: 0 }] : []),
    { accountId: '1100', debitPence: 0, creditPence: credit.totalPence },
  ] : [
    { accountId: '2000', debitPence: credit.totalPence, creditPence: 0 },
    { accountId: '6000', debitPence: 0, creditPence: credit.netPence },
    ...(credit.vatPence ? [{ accountId: '1200', debitPence: 0, creditPence: credit.vatPence }] : []),
  ];
  return { id: `credit-${credit.id}`, date: credit.date, reference: credit.number, description: `Credit against ${document.number}: ${credit.reason}`, lines, createdAt: credit.createdAt, createdBy: credit.createdBy };
}
