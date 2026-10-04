import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, documentJournal, paymentJournal, type AccountingPayment } from '../src/aws/shared/accounting.js';
import { buildAgingReport } from '../src/aws/shared/accountingAging.js';
import { reminderCandidate, reminderText, type AccountingEmailRecord, type AccountingReminderSettings } from '../src/aws/shared/accountingReminders.js';

const invoice = createDocument({ kind: 'invoice', number: 'INV-42', contactName: 'Customer Ltd', issuerName: 'Example Business', issuerAddress: '1 Street', contactAddress: '2 Street', vatNumber: '', paymentInstructions: '', date: '2026-09-01', taxDate: '2026-09-01', dueDate: '2026-09-30', items: [{ description: 'Service', quantity: 1, unitPricePence: 10000, vatRate: 0, vatCode: 'S0' }] }, 'owner');
const settings: AccountingReminderSettings = { enabled: true, days: [7, 14, 30], replyToEmail: 'accounts@example.com', excludedDocumentIds: [], updatedAt: '', updatedBy: '' };
const original: AccountingEmailRecord = { id: 'mail-1', documentId: invoice.id, recipient: 'customer@example.com', kind: 'invoice', status: 'delivered', requestedAt: '2026-09-01T10:00:00Z', deliveredAt: '2026-09-01T10:00:30Z' };
const base = { documents: [invoice], payments: [] as AccountingPayment[], settlements: [], creditNotes: [], refunds: [], reversals: [], entries: [documentJournal(invoice)] };

test('only a delivered, open invoice at an enabled milestone qualifies', () => {
  const today = '2026-10-07';
  const row = buildAgingReport(today, base).receivables.rows[0];
  assert.deepEqual(reminderCandidate(invoice, row, [original], settings, today), { recipient: 'customer@example.com', milestoneDay: 7, amountPence: 10000 });
  assert.equal(reminderCandidate(invoice, row, [{ ...original, status: 'bounced' }], settings, today), null);
  assert.equal(reminderCandidate(invoice, row, [original], { ...settings, enabled: false }, today), null);
  assert.equal(reminderCandidate(invoice, row, [original], { ...settings, excludedDocumentIds: [invoice.id] }, today), null);
  assert.equal(reminderCandidate(invoice, row, [{ ...original, deliveredAt: `${today}T09:00:00Z` }], settings, today), null);
  assert.equal(reminderCandidate(invoice, row, [{ ...original, deliveredAt: undefined }], settings, today), null);
  const prior: AccountingEmailRecord = { ...original, id: 'reminder-7', kind: 'reminder', milestoneDay: 7, status: 'delivered' };
  assert.equal(reminderCandidate(invoice, row, [original, prior], settings, today), null);
  assert.equal(reminderCandidate(invoice, buildAgingReport('2026-10-08', base).receivables.rows[0], [original], settings, '2026-10-08'), null);
});

test('reminders use the remaining balance and stop for paid or uncertain mail', () => {
  const payment: AccountingPayment = { id: 'pay-1', documentId: invoice.id, date: '2026-10-03', amountPence: 4000, reference: '', createdAt: '2026-10-03T10:00:00Z', createdBy: 'owner' };
  const books = { ...base, payments: [payment], entries: [...base.entries, paymentJournal(payment, invoice)] };
  const row = buildAgingReport('2026-10-07', books).receivables.rows[0];
  assert.equal(reminderCandidate(invoice, row, [original], settings, '2026-10-07')?.amountPence, 6000);
  assert.match(reminderText(invoice, 6000), /GBP 60\.00/);
  assert.equal(reminderCandidate(invoice, row, [original, { ...original, id: 'retry', kind: 'reminder', status: 'uncertain', milestoneDay: 3 }], settings, '2026-10-07'), null);
  const paid: AccountingPayment = { ...payment, id: 'pay-2', amountPence: 6000 };
  const paidBooks = { ...books, payments: [payment, paid], entries: [...books.entries, paymentJournal(paid, invoice)] };
  assert.equal(reminderCandidate(invoice, buildAgingReport('2026-10-07', paidBooks).receivables.rows[0], [original], settings, '2026-10-07'), null);
});
