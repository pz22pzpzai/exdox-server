import assert from 'node:assert/strict';
import test from 'node:test';
import { createSourcePosting, sourceJournal } from '../src/aws/shared/accountingSourcePosting.js';
import type { ReceiptRow } from '../src/aws/types.js';

const receipt = { id: 17, workspaceContext: 'cost', status: 'Ready', needsReview: false, baseCurrency: 'GBP', currency: 'GBP', totalAmount: 120, netAmount: 100, vatAmount: 20, invoiceDate: '2026-09-01', createdAt: '2026-09-01T10:00:00Z', updatedAt: '2026-09-02T10:00:00Z', vendorName: 'Vendor', invoiceNumber: 'V-17', mileageClaimId: null } as ReceiptRow;

test('approved GBP cost posts a balanced payable snapshot', () => {
  const posting = createSourcePosting(receipt, 'GB', 'terryreedbfv@outlook.com');
  const journal = sourceJournal(posting);
  assert.equal(posting.id, 'receipt-17');
  assert.equal(journal.lines.reduce((sum, line) => sum + line.debitPence - line.creditPence, 0), 0);
  assert.equal(journal.lines.find((line) => line.accountId === '2000')?.creditPence, 12000);
});

test('sales map to receivables and unreviewed or foreign records are rejected', () => {
  const sale = createSourcePosting({ ...receipt, workspaceContext: 'sales' }, 'GB', 'terryreedbfv@outlook.com');
  assert.equal(sourceJournal(sale).lines.find((line) => line.accountId === '1100')?.debitPence, 12000);
  assert.throws(() => createSourcePosting({ ...receipt, needsReview: true }, 'GB', 'owner'), /Review and approve/);
  assert.throws(() => createSourcePosting(receipt, 'US', 'owner'), /Only UK workspaces/);
  assert.throws(() => createSourcePosting({ ...receipt, totalAmount: 119 }, 'GB', 'owner'), /net plus VAT/);
});
