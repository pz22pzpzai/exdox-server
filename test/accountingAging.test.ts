import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, documentJournal, paymentJournal, type AccountingPayment } from '../src/aws/shared/accounting.js';
import { creditJournal, reversalJournal, type CreditNote, type Reversal } from '../src/aws/shared/accountingSafeguards.js';
import { refundJournal, settlementJournal, type AccountingRefund, type AccountingSettlement } from '../src/aws/shared/accountingLifecycle.js';
import { buildAgingReport } from '../src/aws/shared/accountingAging.js';

const invoice = createDocument({ kind: 'invoice', number: 'INV-1', contactName: 'Client Ltd', issuerName: 'Test Business', issuerAddress: '1 Street', contactAddress: '2 Street', vatNumber: '', paymentInstructions: '', date: '2026-01-01', taxDate: '2026-01-01', dueDate: '2026-01-31', items: [{ description: 'Service', quantity: 1, unitPricePence: 10000, vatRate: 0, vatCode: 'S0' }] }, 'owner');
const bill = createDocument({ kind: 'bill', number: 'BILL-1', contactName: 'Supplier Ltd', issuerName: '', issuerAddress: '', contactAddress: '', vatNumber: '', paymentInstructions: '', date: '2026-01-02', taxDate: '2026-01-02', dueDate: '2026-01-10', items: [{ description: 'Materials', quantity: 1, unitPricePence: 5000, vatRate: 0, vatCode: 'P0' }] }, 'owner');
const payment: AccountingPayment = { id: 'pay-1', documentId: invoice.id, date: '2026-01-15', amountPence: 8000, reference: '', createdAt: '2026-01-15T10:00:00Z', createdBy: 'owner' };
const credit: CreditNote = { id: 'credit-1', documentId: invoice.id, number: 'CN-1', date: '2026-02-01', reason: 'Correction', items: [{ itemIndex: 0, quantity: 1 }], netPence: 3000, vatPence: 0, totalPence: 3000, createdAt: '2026-02-01T10:00:00Z', createdBy: 'owner' };
const refund: AccountingRefund = { id: 'refund-1', creditId: credit.id, date: '2026-02-10', reference: '', amountPence: 1000, createdAt: '2026-02-10T10:00:00Z', createdBy: 'owner' };
const settlement: AccountingSettlement = { id: 'settle-1', kind: 'bill', date: '2026-02-05', reference: '', allocations: [{ documentId: bill.id, amountPence: 1000 }], totalPence: 1000, createdAt: '2026-02-05T10:00:00Z', createdBy: 'owner' };
const reversal: Reversal = { targetEntryId: `payment-${payment.id}`, date: '2026-02-20', reason: 'Payment reversed', createdAt: '2026-02-20T10:00:00Z', createdBy: 'owner' };
const paymentEntry = paymentJournal(payment, invoice);
const books = { documents: [invoice, bill], payments: [payment], creditNotes: [credit], refunds: [refund], settlements: [settlement], reversals: [reversal], entries: [documentJournal(invoice), documentJournal(bill), paymentEntry, creditJournal(credit, invoice), refundJournal(refund, true), settlementJournal(settlement), reversalJournal(reversal, paymentEntry)] };

test('aging respects as-of dates, credits, refunds, settlements and later reversals', () => {
  const january = buildAgingReport('2026-01-20', books);
  assert.equal(january.receivables.documentBalancePence, 2000);
  assert.equal(january.payables.documentBalancePence, 5000);
  assert.equal(january.receivables.buckets.current, 2000);
  assert.equal(january.payables.buckets.days1to30, 5000);
  const february = buildAgingReport('2026-02-05', books);
  assert.equal(february.receivables.buckets.credit, -1000);
  assert.equal(february.payables.documentBalancePence, 4000);
  const afterRefund = buildAgingReport('2026-02-15', books);
  assert.equal(afterRefund.receivables.rows.length, 0);
  const afterReversal = buildAgingReport('2026-02-25', books);
  assert.equal(afterReversal.receivables.documentBalancePence, 8000);
  assert.equal(afterReversal.receivables.buckets.days1to30, 8000);
  assert.equal(afterReversal.receivables.differencePence, 0);
  assert.equal(afterReversal.payables.differencePence, 0);
});

test('aging exposes control-account entries outside the document subledger', () => {
  const report = buildAgingReport('2026-02-25', { ...books, entries: [...books.entries, { id: 'manual-1', date: '2026-02-22', reference: '', description: 'Opening balance', lines: [{ accountId: '1100', debitPence: 500, creditPence: 0 }], createdAt: '2026-02-22T10:00:00Z', createdBy: 'owner' }] });
  assert.equal(report.receivables.differencePence, 500);
  assert.throws(() => buildAgingReport('2026-02-31', books));
});
