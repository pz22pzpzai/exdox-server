import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceRecurrence, createRecurrence, recurringDraft } from '../src/aws/shared/accountingRecurring.js';
import { createDraft } from '../src/aws/shared/accountingLifecycle.js';

const template = createDraft({ kind: 'bill', number: 'RENT-BASE', contactName: 'Landlord Ltd', issuerName: '', issuerAddress: '', contactAddress: '', vatNumber: '', paymentInstructions: '', date: '2026-10-01', taxDate: '2026-10-01', dueDate: '2026-10-15', items: [{ description: 'Office rent', quantity: 1, unitPricePence: 10000, vatRate: 0, vatCode: 'P0' }] }, 'owner');

test('monthly recurrence keeps its intended month-end day and creates repeatable review drafts', () => {
  const schedule = createRecurrence({ nextDate: '2026-01-31', frequency: 'monthly', dueDays: 14, numberPrefix: 'RENT', label: 'Office rent' }, template, 'owner', '2026-01-01');
  assert.equal(advanceRecurrence(schedule, '2026-01-31'), '2026-02-28');
  assert.equal(advanceRecurrence(schedule, '2026-02-28'), '2026-03-31');
  const first = recurringDraft(schedule, '2026-01-31');
  assert.equal(first.id, recurringDraft(schedule, '2026-01-31').id);
  assert.equal(first.document.number, 'RENT-20260131');
  assert.equal(first.document.date, '2026-01-31');
  assert.equal(first.document.taxDate, '2026-01-31');
  assert.equal(first.document.dueDate, '2026-02-14');
  assert.equal(first.document.totalPence, 10000);
  assert.notEqual(first.id, recurringDraft(schedule, '2026-02-28').id);
});

test('recurrence requires a unique usable prefix and a current or future date', () => {
  assert.throws(() => createRecurrence({ nextDate: '2025-12-31', frequency: 'weekly', dueDays: 14, numberPrefix: 'RENT', label: 'Office rent' }, template, 'owner', '2026-01-01'));
  assert.throws(() => createRecurrence({ nextDate: '2026-01-31', frequency: 'monthly', dueDays: 14, numberPrefix: 'bad prefix', label: 'Office rent' }, template, 'owner', '2026-01-01'));
});
