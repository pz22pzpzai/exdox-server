import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { AccountingDocument } from './accounting.js';
import { awsEnv } from './env.js';
import { getReceiptJsonObject, putReceiptJsonObject, putReceiptJsonObjectIfAbsent } from './s3.js';

export type InvoiceLink = { documentId: string; nonce: string; active: boolean; createdAt: string };
const tokenPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const tokenBody = (orgId: number, documentId: string, nonce: string) => Buffer.from(`${orgId}:${documentId}:${nonce}`).toString('base64url');
const signature = (body: string) => createHmac('sha256', awsEnv.jwtSecret).update(`accounting-invoice:${body}`).digest('base64url');
export const invoiceToken = (orgId: number, link: InvoiceLink) => { const body = tokenBody(orgId, link.documentId, link.nonce); return `${body}.${signature(body)}`; };
export const invoiceUrl = (orgId: number, link: InvoiceLink) => `https://exdox.co.uk/invoice/${invoiceToken(orgId, link)}`;
export function decodeInvoiceToken(token: string): { orgId: number; documentId: string; nonce: string } | null {
  if (!tokenPattern.test(token) || token.length > 250) return null;
  const [body, supplied] = token.split('.');
  const expected = Buffer.from(signature(body));
  const actual = Buffer.from(supplied);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  const [org, documentId, nonce, extra] = Buffer.from(body, 'base64url').toString('utf8').split(':');
  const orgId = Number(org);
  if (extra !== undefined || !Number.isSafeInteger(orgId) || orgId <= 0 || !/^[0-9a-f-]{36}$/.test(documentId) || !/^[A-Za-z0-9_-]{32}$/.test(nonce)) return null;
  return { orgId, documentId, nonce };
}
export async function currentInvoiceLink(prefix: string, documentId: string): Promise<InvoiceLink | null> {
  try { return await getReceiptJsonObject<InvoiceLink>(`${prefix}invoice-links/${documentId}.json`); }
  catch (error) {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (value.name === 'NoSuchKey' || value.name === 'NotFound' || value.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
export async function ensureInvoiceLink(prefix: string, documentId: string): Promise<InvoiceLink> {
  const existing = await currentInvoiceLink(prefix, documentId);
  if (existing?.active) return existing;
  const link: InvoiceLink = { documentId, nonce: randomBytes(24).toString('base64url'), active: true, createdAt: new Date().toISOString() };
  if (existing) { await putReceiptJsonObject(`${prefix}invoice-links/${documentId}.json`, link); return link; }
  try { await putReceiptJsonObjectIfAbsent(`${prefix}invoice-links/${documentId}.json`, link); return link; }
  catch (error) {
    const status = typeof error === 'object' && error !== null && '$metadata' in error ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
    if (status !== 412) throw error;
    const concurrent = await currentInvoiceLink(prefix, documentId);
    if (!concurrent?.active) throw new Error('Invoice link creation needs retrying.');
    return concurrent;
  }
}

const money = (pence: number) => `£${(pence / 100).toFixed(2)}`;
const safeText = (value: string) => value.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/\u2022/g, '-').replace(/[\u0000-\u001f]/g, ' ').replace(/[^\u0020-\u007e\u00a0-\u00ff]/g, '?');

export async function invoicePdf(document: AccountingDocument): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const navy = rgb(0.10, 0.16, 0.30);
  const gray = rgb(0.35, 0.40, 0.48);
  const teal = rgb(0.03, 0.46, 0.49);
  let page: PDFPage = pdf.addPage([595.28, 841.89]);
  let y = 790;
  const margin = 48;
  function topRule() { page.drawRectangle({ x: 0, y: 823, width: 595.28, height: 18.89, color: teal }); }
  function newPage() { page = pdf.addPage([595.28, 841.89]); topRule(); y = 790; }
  function line(value: string, font: PDFFont = regular, size = 10, color = navy, indent = 0, gap = 17) {
    if (y < 65) newPage();
    const text = safeText(value);
    const max = 595.28 - margin * 2 - indent;
    const words: string[] = [];
    for (const word of text.split(/\s+/)) {
      let part = '';
      for (const character of word) {
        if (part && font.widthOfTextAtSize(part + character, size) > max) { words.push(part); part = character; }
        else part += character;
      }
      if (part) words.push(part);
    }
    let current = '';
    const draw = (part: string) => { if (y < 65) newPage(); page.drawText(part, { x: margin + indent, y, size, font, color }); y -= gap; };
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) > max && current) { draw(current); current = word; }
      else current = next;
    }
    if (current) draw(current);
  }
  topRule();
  line(document.issuerName, bold, 21, navy, 0, 27);
  for (const part of document.issuerAddress.split(/\r?\n/)) line(part, regular, 9, gray, 0, 13);
  y -= 16;
  line('INVOICE', bold, 18, teal, 0, 27);
  line(`Invoice number: ${document.number}`, bold, 11);
  line(`Issue date: ${document.date}    Due date: ${document.dueDate}`);
  line(`Tax date: ${document.taxDate || document.date}`);
  if (document.vatNumber) line(`VAT number: ${document.vatNumber}`);
  y -= 14;
  line('BILL TO', bold, 10, teal);
  line(document.contactName, bold, 11);
  for (const part of document.contactAddress.split(/\r?\n/)) line(part, regular, 9, gray, 0, 13);
  y -= 18;
  line('ITEMS', bold, 10, teal);
  page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: 595.28 - margin, y: y + 4 }, thickness: 1, color: teal });
  y -= 12;
  for (const item of document.items) {
    if (y < 110) newPage();
    line(item.description, bold, 10);
    line(`${item.quantity} × ${money(item.unitPricePence)}    VAT ${item.vatRate}%    Net ${money(item.quantity * item.unitPricePence)}    Total ${money(Math.round(item.quantity * item.unitPricePence * (100 + item.vatRate) / 100))}`, regular, 9, gray, 0, 15);
    y -= 4;
  }
  if (y < 130) newPage();
  page.drawLine({ start: { x: margin, y: y + 4 }, end: { x: 595.28 - margin, y: y + 4 }, thickness: 1, color: teal });
  y -= 14;
  line(`Net: ${money(document.netPence)}`);
  line(`VAT: ${money(document.vatPence)}`);
  line(`TOTAL DUE: ${money(document.totalPence)}`, bold, 15, navy, 0, 23);
  if (document.paymentInstructions) {
    y -= 10;
    line('PAYMENT INSTRUCTIONS', bold, 10, teal);
    for (const part of document.paymentInstructions.split(/\r?\n/)) line(part, regular, 10);
  }
  for (const [index, pdfPage] of pdf.getPages().entries()) pdfPage.drawText(`Invoice ${safeText(document.number)} - Page ${index + 1} of ${pdf.getPageCount()}`, { x: margin, y: 30, font: regular, size: 8, color: gray });
  return pdf.save();
}
