import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, createPayment, documentJournal } from '../src/aws/shared/accounting.js';
import { assertOpenPeriod, createCreditNote, createPeriodLock, createReversal, creditJournal, lockedThrough, reversalJournal } from '../src/aws/shared/accountingSafeguards.js';

const owner = 'terryreedbfv@outlook.com';
const bill = () => createDocument({ kind: 'bill', number: 'B-100', contactName: 'Supplier', date: '2026-09-01', dueDate: '2026-09-30', items: [{ description: 'Service', quantity: 2, unitPricePence: 1, vatRate: 20 }] }, owner);

test('period close is monotonic and rejects backdated posting', () => {
  const first = createPeriodLock({ lockedThrough: '2026-09-30', reason: 'September close' }, [], owner);
  assert.equal(lockedThrough([first]), '2026-09-30');
  assert.throws(() => assertOpenPeriod('2026-09-30', first.lockedThrough), /locked/);
  assert.doesNotThrow(() => assertOpenPeriod('2026-10-01', first.lockedThrough));
  assert.throws(() => createPeriodLock({ lockedThrough: '2026-09-29', reason: 'Earlier close' }, [first], owner), /already locked/);
});

test('reversal preserves original and has exact opposite ledger effect', () => {
  const entry = documentJournal(bill());
  const reversal = createReversal({ date: '2026-10-01', reason: 'Supplier cancelled' }, entry, [], '2026-09-30', owner);
  const opposite = reversalJournal(reversal, entry);
  assert.deepEqual(opposite.lines.map((line) => [line.debitPence, line.creditPence]), entry.lines.map((line) => [line.creditPence, line.debitPence]));
  assert.throws(() => createReversal({ date: '2026-10-01', reason: 'Again cancelled' }, entry, [reversal], '2026-09-30', owner), /already been reversed/);
});

test('partial credit allocates VAT cumulatively and reduces payment capacity', () => {
  const document = bill();
  const first = createCreditNote({ number: 'CN-1', date: '2026-10-01', reason: 'One unit returned', items: [{ itemIndex: 0, quantity: 1 }] }, document, [], [], null, owner);
  const second = createCreditNote({ number: 'CN-2', date: '2026-10-02', reason: 'Other unit returned', items: [{ itemIndex: 0, quantity: 1 }] }, document, [first], [], null, owner);
  assert.equal(first.totalPence + second.totalPence, document.totalPence);
  for (const credit of [first, second]) {
    const lines = creditJournal(credit, document).lines;
    assert.equal(lines.reduce((sum, line) => sum + line.debitPence - line.creditPence, 0), 0);
  }
  assert.throws(() => createPayment({ date: '2026-10-03', amountPence: 1 }, document, [], owner, first.totalPence + second.totalPence), /exceeds/);
  assert.throws(() => createCreditNote({ number: 'CN-3', date: '2026-10-03', reason: 'Extra unit returned', items: [{ itemIndex: 0, quantity: 1 }] }, document, [first, second], [], null, owner), /exceeds/);
});
