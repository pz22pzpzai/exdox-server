import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { createDocument } from '../src/aws/shared/accounting.js';

process.env.RECEIPT_BUCKET_NAME ||= 'test-receipts';
process.env.OPENAI_API_KEY ||= 'test';
process.env.JWT_SECRET ||= 'test-invoice-link-secret';
const { decodeInvoiceToken, invoicePdf, invoiceToken } = await import('../src/aws/shared/accountingInvoicePresentation.js');
const document = createDocument({ kind: 'invoice', number: 'INV-2026-042', contactName: 'Customer Ltd', issuerName: 'Example Business', issuerAddress: '1 Main Road\nLondon', contactAddress: '2 High Street\nBristol', vatNumber: 'GB123456789', paymentInstructions: 'Pay by bank transfer quoting INV-2026-042.', date: '2026-10-04', dueDate: '2026-10-18', items: [{ description: 'Consulting services for October', quantity: 2, unitPricePence: 10000, vatRate: 20, vatCode: 'S20' }] }, 'owner');

test('invoice links are signed, organisation-bound, and reject edits', () => {
  const link = { documentId: document.id, nonce: 'a'.repeat(32), active: true, createdAt: '2026-10-04T00:00:00Z' };
  const token = invoiceToken(42, link);
  assert.deepEqual(decodeInvoiceToken(token), { orgId: 42, documentId: document.id, nonce: link.nonce });
  assert.equal(decodeInvoiceToken(`${token.slice(0, -1)}x`), null);
  assert.equal(decodeInvoiceToken('not-an-invoice-token'), null);
});

test('invoice PDF contains a complete document and paginates long item lists', async () => {
  const pdf = await invoicePdf(document);
  assert.equal(Buffer.from(pdf).subarray(0, 5).toString(), '%PDF-');
  const parsed = await PDFDocument.load(pdf);
  assert.equal(parsed.getPageCount(), 1);
  const many = { ...document, items: Array.from({ length: 50 }, (_, index) => ({ ...document.items[0], description: `Service line ${index + 1} with a longer explanatory description` })) };
  const longPdf = await PDFDocument.load(await invoicePdf(many));
  assert.ok(longPdf.getPageCount() > 1);
});
