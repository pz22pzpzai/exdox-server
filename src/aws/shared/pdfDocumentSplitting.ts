import { PDFDocument } from 'pdf-lib';

export type PdfDocumentPart = { pageStart: number; pageEnd: number; buffer: Buffer };

export async function splitPdfByPageRanges(
  source: Buffer,
  ranges: Array<{ page_start?: unknown; page_end?: unknown }>,
  mode: 'one_document_per_page' | 'auto_detect',
): Promise<PdfDocumentPart[]> {
  const pdf = await PDFDocument.load(source);
  const pageCount = pdf.getPageCount();
  if (!pageCount || pageCount > 50) throw new Error('PDF splitting supports 1 to 50 pages. Upload a smaller PDF or use one document per file.');
  if (!ranges.length) throw new Error('No documents were detected in this PDF. Try one document per file.');
  if (ranges.length > pageCount) throw new Error('More documents than PDF pages were detected. Try one document per file.');

  let nextPage = 1;
  const parts: PdfDocumentPart[] = [];
  for (const range of ranges) {
    const pageStart = Number(range.page_start);
    const pageEnd = Number(range.page_end);
    if (!Number.isSafeInteger(pageStart) || !Number.isSafeInteger(pageEnd) || pageStart !== nextPage || pageEnd < pageStart || pageEnd > pageCount) {
      throw new Error('The PDF document boundaries could not be verified. Try one document per file or one document per page.');
    }
    if (mode === 'one_document_per_page' && pageStart !== pageEnd) {
      throw new Error('One-document-per-page mode did not return a separate document for each page. Try again or use one document per file.');
    }
    const segment = await PDFDocument.create();
    const copied = await segment.copyPages(pdf, Array.from({ length: pageEnd - pageStart + 1 }, (_, index) => pageStart - 1 + index));
    copied.forEach((page) => segment.addPage(page));
    parts.push({ pageStart, pageEnd, buffer: Buffer.from(await segment.save()) });
    nextPage = pageEnd + 1;
  }
  if (nextPage !== pageCount + 1 || (mode === 'one_document_per_page' && parts.length !== pageCount)) {
    throw new Error('Some PDF pages were not assigned to a document. Try one document per file or one document per page.');
  }
  return parts;
}
