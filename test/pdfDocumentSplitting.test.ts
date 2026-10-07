import assert from 'node:assert/strict';
import test from 'node:test';
import { PDFDocument } from 'pdf-lib';

import { splitPdfByPageRanges } from '../src/aws/shared/pdfDocumentSplitting.js';

async function samplePdf() {
  const pdf = await PDFDocument.create();
  pdf.addPage([300, 400]);
  pdf.addPage([310, 410]);
  pdf.addPage([320, 420]);
  return Buffer.from(await pdf.save());
}

test('split PDF keeps only the pages assigned to each document', async () => {
  const parts = await splitPdfByPageRanges(await samplePdf(), [
    { page_start: 1, page_end: 2 },
    { page_start: 3, page_end: 3 },
  ], 'auto_detect');
  assert.equal(parts.length, 2);
  assert.equal((await PDFDocument.load(parts[0].buffer)).getPageCount(), 2);
  assert.equal((await PDFDocument.load(parts[1].buffer)).getPageCount(), 1);
  assert.deepEqual(parts.map(({ pageStart, pageEnd }) => [pageStart, pageEnd]), [[1, 2], [3, 3]]);
});

test('split PDF rejects missing, overlapping, and wrongly grouped pages', async () => {
  const source = await samplePdf();
  await assert.rejects(splitPdfByPageRanges(source, [{ page_start: 1, page_end: 1 }, { page_start: 3, page_end: 3 }], 'auto_detect'), /boundaries/);
  await assert.rejects(splitPdfByPageRanges(source, [{ page_start: 1, page_end: 2 }, { page_start: 2, page_end: 3 }], 'auto_detect'), /boundaries/);
  await assert.rejects(splitPdfByPageRanges(source, [{ page_start: 1, page_end: 2 }, { page_start: 3, page_end: 3 }], 'one_document_per_page'), /separate document/);
});
