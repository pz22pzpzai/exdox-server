import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, documentJournal } from '../src/aws/shared/accounting.js';
import { buildVatReport, createVatClose } from '../src/aws/shared/accountingVat.js';
import { buildVatFilingPreview } from '../src/aws/shared/accountingVatFiling.js';

const owner = 'terryreedbfv@outlook.com';
const purchase = createDocument({ kind: 'bill', number: 'B-FILING-1', contactName: 'Supplier', date: '2026-09-05', taxDate: '2026-09-05', dueDate: '2026-09-30', items: [{ description: 'Materials', quantity: 1, unitPricePence: 501, vatRate: 20, vatCode: 'P20' }] }, owner);
const report = buildVatReport({ fromDate: '2026-09-01', toDate: '2026-09-30', entries: [documentJournal(purchase)], documents: [purchase], creditNotes: [], sourcePostings: [], reversals: [], classifications: [] });

test('HMRC preview requires a matching closed period and keeps repayment net VAT unsigned', () => {
  const unclosed = buildVatFilingPreview(report, []);
  assert.equal(unclosed.internallyReady, false);
  assert.match(unclosed.blockers.join(' '), /Close the reviewed VAT period/);
  const close = createVatClose(report, [], owner);
  const preview = buildVatFilingPreview(report, [close]);
  assert.equal(preview.internallyReady, true);
  assert.equal(preview.submissionAvailable, false);
  assert.equal(report.boxes.box5, -100);
  assert.equal(preview.fields.netVatDue, 1);
  assert.equal(preview.fields.totalValuePurchasesExVAT, 5);
  assert.equal('periodKey' in preview.fields, false);
  assert.equal('finalised' in preview.fields, false);
  assert.match(buildVatFilingPreview(report, [{ ...close, digest: 'changed' }]).blockers.join(' '), /differs from the closed snapshot/);
});
