import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, createJournal, defaultAccounts, documentJournal } from '../src/aws/shared/accounting.js';
import { createCreditNote, createReversal, creditJournal, reversalJournal } from '../src/aws/shared/accountingSafeguards.js';
import { assertVatOpen, buildVatReport, createVatClassification, createVatClose } from '../src/aws/shared/accountingVat.js';

const owner = 'terryreedbfv@outlook.com';
const invoice = () => createDocument({ kind: 'invoice', number: 'INV-10', contactName: 'Customer Ltd', issuerName: 'Exdox', issuerAddress: 'London', contactAddress: 'Manchester', vatNumber: 'GB123', date: '2026-09-01', dueDate: '2026-09-30', items: [
  { description: 'Service', quantity: 1, unitPricePence: 10000, vatRate: 20, vatCode: 'S20' },
  { description: 'Zero rated goods', quantity: 1, unitPricePence: 5000, vatRate: 0, vatCode: 'S0' },
] }, owner);
const bill = () => createDocument({ kind: 'bill', number: 'B-10', contactName: 'Supplier Ltd', date: '2026-09-05', dueDate: '2026-09-30', items: [
  { description: 'Materials', quantity: 1, unitPricePence: 4000, vatRate: 20, vatCode: 'P20' },
] }, owner);

test('nine boxes trace sales, zero-rated items, purchases, credits and reversals', () => {
  const sale = invoice();
  const purchase = bill();
  const credit = createCreditNote({ documentId: sale.id, number: 'CN-10', date: '2026-10-01', reason: 'Service cancelled', items: [{ itemIndex: 0, quantity: 1 }] }, sale, [], [], null, owner);
  const reversal = createReversal({ date: '2026-10-02', reason: 'Bill duplicated' }, documentJournal(purchase), [], null, owner);
  const entries = [documentJournal(sale), documentJournal(purchase), creditJournal(credit, sale), reversalJournal(reversal, documentJournal(purchase))];
  const input = { entries, documents: [sale, purchase], creditNotes: [credit], sourcePostings: [], reversals: [reversal], classifications: [] };
  const september = buildVatReport({ fromDate: '2026-09-01', toDate: '2026-09-30', ...input });
  assert.equal(september.ready, true);
  assert.deepEqual([september.boxes.box1, september.boxes.box3, september.boxes.box4, september.boxes.box5, september.boxes.box6, september.boxes.box7], [2000, 2000, 800, 1200, 15000, 4000]);
  const october = buildVatReport({ fromDate: '2026-10-01', toDate: '2026-10-31', ...input });
  assert.deepEqual([october.boxes.box1, october.boxes.box4, october.boxes.box5, october.boxes.box6, october.boxes.box7], [-2000, -800, -1200, -10000, -4000]);
  assert.equal(october.rows.length, 2);
});

test('manual VAT classification must match VAT ledger movement and closes freeze tax dates', () => {
  const entry = createJournal({ date: '2026-09-10', description: 'Reviewed input VAT adjustment', lines: [
    { accountId: '6000', debitPence: 10000, creditPence: 0 },
    { accountId: '1200', debitPence: 2000, creditPence: 0 },
    { accountId: '2000', debitPence: 0, creditPence: 12000 },
  ] }, defaultAccounts, owner);
  const payload = { taxDate: '2026-09-10', reason: 'Supported by supplier VAT invoice', boxes: { box1: 0, box2: 0, box4: 2000, box6: 0, box7: 10000, box8: 0, box9: 0 } };
  assert.throws(() => createVatClassification({ ...payload, boxes: { ...payload.boxes, box4: 1999 } }, entry, [], owner), /must match/);
  const unclassified = buildVatReport({ fromDate: '2026-09-01', toDate: '2026-09-30', entries: [entry], documents: [], creditNotes: [], sourcePostings: [], reversals: [], classifications: [] });
  assert.equal(unclassified.ready, false);
  assert.throws(() => createVatClose(unclassified, [], owner), /Classify every/);
  const classification = createVatClassification(payload, entry, [], owner);
  const report = buildVatReport({ fromDate: '2026-09-01', toDate: '2026-09-30', entries: [entry], documents: [], creditNotes: [], sourcePostings: [], reversals: [], classifications: [classification] });
  assert.equal(report.ready, true);
  assert.equal(report.boxes.box4, 2000);
  const close = createVatClose(report, [], owner);
  assert.throws(() => assertVatOpen('2026-09-10', [close]), /closed/);
  assert.doesNotThrow(() => assertVatOpen('2026-10-01', [close]));
  assert.throws(() => createVatClose(report, [close], owner), /overlaps/);
});

test('older documents without a VAT code remain visible for review', () => {
  const sale = invoice();
  sale.items[0].vatCode = undefined;
  const report = buildVatReport({ fromDate: '2026-09-01', toDate: '2026-09-30', entries: [documentJournal(sale)], documents: [sale], creditNotes: [], sourcePostings: [], reversals: [], classifications: [] });
  assert.equal(report.ready, false);
  assert.equal(report.issues[0].entryId, `document-${sale.id}`);
  assert.throws(() => createDocument({ kind: 'bill', number: 'B-2', contactName: 'Supplier', date: '2026-09-01', dueDate: '2026-09-30', items: [{ description: 'Wrong VAT code', quantity: 1, unitPricePence: 100, vatRate: 0, vatCode: 'P20' }] }, owner), /VAT code/);
});

test('reversing an unclassified older entry is also flagged for review', () => {
  const sale = invoice();
  sale.items[0].vatCode = undefined;
  sale.items[1].vatCode = undefined;
  const original = documentJournal(sale);
  const reversal = createReversal({ date: '2026-10-01', reason: 'Invoice cancelled' }, original, [], null, owner);
  const report = buildVatReport({ fromDate: '2026-10-01', toDate: '2026-10-31', entries: [original, reversalJournal(reversal, original)], documents: [sale], creditNotes: [], sourcePostings: [], reversals: [reversal], classifications: [] });
  assert.equal(report.ready, false);
  assert.equal(report.issues[0].entryId, `reversal-${original.id}`);
});

test('a reviewed tax point can precede the invoice issue date', () => {
  const sale = createDocument({ kind: 'invoice', number: 'INV-11', contactName: 'Customer Ltd', issuerName: 'Exdox', issuerAddress: 'London', contactAddress: 'Manchester', vatNumber: 'GB123', date: '2026-09-01', taxDate: '2026-08-25', dueDate: '2026-09-30', items: [{ description: 'Earlier supply', quantity: 1, unitPricePence: 10000, vatRate: 20, vatCode: 'S20' }] }, owner);
  const report = buildVatReport({ fromDate: '2026-08-01', toDate: '2026-08-31', entries: [documentJournal(sale)], documents: [sale], creditNotes: [], sourcePostings: [], reversals: [], classifications: [] });
  assert.equal(report.boxes.box1, 2000);
  assert.equal(report.rows[0].taxDate, '2026-08-25');
});
