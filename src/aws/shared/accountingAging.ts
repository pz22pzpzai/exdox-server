import type { AccountingDocument, AccountingPayment, JournalEntry } from './accounting.js';
import type { CreditNote, Reversal } from './accountingSafeguards.js';
import type { AccountingRefund, AccountingSettlement } from './accountingLifecycle.js';
import { validBookDate } from './accountingSafeguards.js';

export type AgingBooks = { documents: AccountingDocument[]; payments: AccountingPayment[]; settlements: AccountingSettlement[]; creditNotes: CreditNote[]; refunds: AccountingRefund[]; reversals: Reversal[]; entries: JournalEntry[] };
export type AgingBucket = 'current' | 'days1to30' | 'days31to60' | 'days61to90' | 'days91plus' | 'credit';
export type AgingRow = { documentId: string; number: string; contactName: string; issueDate: string; dueDate: string; originalPence: number; outstandingPence: number; daysOverdue: number; bucket: AgingBucket };
export type AgingSide = { rows: AgingRow[]; buckets: Record<AgingBucket, number>; documentBalancePence: number; ledgerBalancePence: number; differencePence: number };
export type AgingReport = { asOf: string; receivables: AgingSide; payables: AgingSide };

function daysBetween(from: string, to: string) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function buildAgingReport(asOf: string, books: AgingBooks): AgingReport {
  if (!validBookDate(asOf)) throw new Error('Choose a valid report date.');
  const reversed = new Set(books.reversals.filter((item) => item.date <= asOf).map((item) => item.targetEntryId));
  const active = (type: string, id: string, date: string) => date <= asOf && !reversed.has(`${type}-${id}`);
  const control = (accountId: string, kind: 'invoice' | 'bill') => books.entries.filter((entry) => entry.date <= asOf).reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountId === accountId).reduce((value, line) => value + (kind === 'invoice' ? line.debitPence - line.creditPence : line.creditPence - line.debitPence), 0), 0);

  const side = (kind: 'invoice' | 'bill'): AgingSide => {
    const rows: AgingRow[] = [];
    const buckets: AgingSide['buckets'] = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days91plus: 0, credit: 0 };
    for (const document of books.documents) {
      if (document.kind !== kind || !active('document', document.id, document.date)) continue;
      const creditIds = new Set(books.creditNotes.filter((credit) => credit.documentId === document.id).map((credit) => credit.id));
      const payments = books.payments.filter((item) => item.documentId === document.id && active('payment', item.id, item.date)).reduce((sum, item) => sum + item.amountPence, 0);
      const settlements = books.settlements.filter((item) => active('settlement', item.id, item.date)).flatMap((item) => item.allocations).filter((item) => item.documentId === document.id).reduce((sum, item) => sum + item.amountPence, 0);
      const credits = books.creditNotes.filter((item) => creditIds.has(item.id) && active('credit', item.id, item.date)).reduce((sum, item) => sum + item.totalPence, 0);
      const refunds = books.refunds.filter((item) => creditIds.has(item.creditId) && active('refund', item.id, item.date)).reduce((sum, item) => sum + item.amountPence, 0);
      const outstandingPence = document.totalPence - payments - settlements - credits + refunds;
      if (!outstandingPence) continue;
      const daysOverdue = Math.max(0, daysBetween(document.dueDate, asOf));
      const bucket: AgingBucket = outstandingPence < 0 ? 'credit' : daysOverdue === 0 ? 'current' : daysOverdue <= 30 ? 'days1to30' : daysOverdue <= 60 ? 'days31to60' : daysOverdue <= 90 ? 'days61to90' : 'days91plus';
      buckets[bucket] += outstandingPence;
      rows.push({ documentId: document.id, number: document.number, contactName: document.contactName, issueDate: document.date, dueDate: document.dueDate, originalPence: document.totalPence, outstandingPence, daysOverdue, bucket });
    }
    rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.contactName.localeCompare(b.contactName) || a.number.localeCompare(b.number));
    const documentBalancePence = rows.reduce((sum, item) => sum + item.outstandingPence, 0);
    const ledgerBalancePence = control(kind === 'invoice' ? '1100' : '2000', kind);
    return { rows, buckets, documentBalancePence, ledgerBalancePence, differencePence: ledgerBalancePence - documentBalancePence };
  };
  return { asOf, receivables: side('invoice'), payables: side('bill') };
}
