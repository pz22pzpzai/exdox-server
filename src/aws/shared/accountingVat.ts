import { createHash, randomUUID } from 'node:crypto';
import type { AccountingDocument, JournalEntry } from './accounting.js';
import type { CreditNote, Reversal } from './accountingSafeguards.js';
import type { SourcePosting } from './accountingSourcePosting.js';

export type VatCode = 'S20' | 'S5' | 'S0' | 'SE' | 'P20' | 'P5' | 'P0' | 'PE';
export type VatBox = 1 | 2 | 4 | 6 | 7 | 8 | 9;
export type VatAmounts = Record<'box1' | 'box2' | 'box4' | 'box6' | 'box7' | 'box8' | 'box9', number>;
export type VatClassification = { id: string; entryId: string; taxDate: string; reason: string; boxes: VatAmounts; createdAt: string; createdBy: string };
export type VatClose = { id: string; fromDate: string; toDate: string; boxes: VatAmounts & { box3: number; box5: number }; digest: string; rowCount: number; closedAt: string; closedBy: string };
export type VatRow = { id: string; entryId: string; taxDate: string; reference: string; description: string; code: string; boxes: VatAmounts };
export type VatIssue = { entryId: string; date: string; reference: string; description: string; reason: string };

export const emptyVatAmounts = (): VatAmounts => ({ box1: 0, box2: 0, box4: 0, box6: 0, box7: 0, box8: 0, box9: 0 });
const boxKeys = Object.keys(emptyVatAmounts()) as Array<keyof VatAmounts>;
export function validVatDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function assertVatOpen(date: string, closes: VatClose[]) {
  if (!validVatDate(date)) throw new Error('Enter a valid VAT tax date.');
  if (closes.some((item) => date >= item.fromDate && date <= item.toDate)) throw new Error(`VAT period containing ${date} is closed. Enter a dated correction in an open period.`);
}
export function validateVatCode(code: unknown, kind: 'invoice' | 'bill' | 'sales' | 'cost', vatRate: 0 | 5 | 20): VatCode {
  const value = String(code ?? '');
  const allowed = kind === 'invoice' || kind === 'sales' ? ['S20', 'S5', 'S0', 'SE'] : ['P20', 'P5', 'P0', 'PE'];
  if (!allowed.includes(value) || (vatRate === 20 && !value.endsWith('20')) || (vatRate === 5 && !value.endsWith('5')) || (vatRate === 0 && !['S0', 'SE', 'P0', 'PE'].includes(value))) throw new Error('Select a VAT code that matches the document type and VAT rate.');
  return value as VatCode;
}
export function vatBoxes(code: VatCode, netPence: number, vatPence: number): VatAmounts {
  const boxes = emptyVatAmounts();
  if (code.startsWith('S')) { boxes.box1 = vatPence; boxes.box6 = netPence; }
  else { boxes.box4 = vatPence; boxes.box7 = netPence; }
  return boxes;
}
export function createVatClassification(input: unknown, entry: JournalEntry, closes: VatClose[], createdBy: string): VatClassification {
  const data = input as Record<string, unknown>;
  const taxDate = String(data?.taxDate ?? '');
  const reason = String(data?.reason ?? '').trim();
  assertVatOpen(taxDate, closes);
  if (reason.length < 5 || reason.length > 240) throw new Error('Give a reason for the VAT classification.');
  const source = data?.boxes as Record<string, unknown> | undefined;
  const boxes = emptyVatAmounts();
  for (const key of boxKeys) {
    const value = Number(source?.[key] ?? 0);
    if (!Number.isSafeInteger(value) || Math.abs(value) > 100_000_000_000) throw new Error('VAT box values must be whole pence within the supported range.');
    boxes[key] = value;
  }
  const vatOutput = entry.lines.filter((line) => line.accountId === '2100').reduce((sum, line) => sum + line.creditPence - line.debitPence, 0);
  const vatInput = entry.lines.filter((line) => line.accountId === '1200').reduce((sum, line) => sum + line.debitPence - line.creditPence, 0);
  if (boxes.box1 + boxes.box2 !== vatOutput || boxes.box4 !== vatInput) throw new Error('VAT boxes 1, 2, and 4 must match this journal’s VAT payable and receivable movements.');
  if (boxes.box8 && Math.abs(boxes.box8) > Math.abs(boxes.box6) || boxes.box9 && Math.abs(boxes.box9) > Math.abs(boxes.box7)) throw new Error('Box 8 cannot exceed box 6 and box 9 cannot exceed box 7.');
  return { id: randomUUID(), entryId: entry.id, taxDate, reason, boxes, createdAt: new Date().toISOString(), createdBy };
}
function addAmounts(target: VatAmounts, source: VatAmounts, sign = 1) { for (const key of boxKeys) target[key] += sign * source[key]; }
function negative(boxes: VatAmounts) { const result = emptyVatAmounts(); addAmounts(result, boxes, -1); return result; }

export function buildVatReport(input: { fromDate: string; toDate: string; entries: JournalEntry[]; documents: AccountingDocument[]; creditNotes: CreditNote[]; sourcePostings: SourcePosting[]; reversals: Reversal[]; classifications: VatClassification[] }) {
  const { fromDate, toDate, entries, documents, creditNotes, sourcePostings, reversals, classifications } = input;
  if (!validVatDate(fromDate) || !validVatDate(toDate) || fromDate > toDate) throw new Error('Choose a valid VAT period.');
  const allRows: VatRow[] = [];
  const issues: VatIssue[] = [];
  const entryById = new Map(entries.map((item) => [item.id, item]));
  const classified = new Map(classifications.map((item) => [item.entryId, item]));
  const addRow = (row: VatRow) => allRows.push(row);
  for (const document of documents) {
    const entryId = `document-${document.id}`;
    if (classified.has(entryId)) continue;
    document.items.forEach((item, index) => {
      if (!item.vatCode) { issues.push({ entryId, date: document.taxDate || document.date, reference: document.number, description: item.description, reason: 'Choose a VAT classification for this older document.' }); return; }
      const vat = Math.round(item.quantity * item.unitPricePence * item.vatRate / 100);
      addRow({ id: `${entryId}:${index}`, entryId, taxDate: document.taxDate || document.date, reference: document.number, description: item.description, code: item.vatCode, boxes: vatBoxes(item.vatCode, item.quantity * item.unitPricePence, vat) });
    });
  }
  const documentsById = new Map(documents.map((item) => [item.id, item]));
  const creditedByLine = new Map<string, number>();
  for (const credit of creditNotes.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
    const document = documentsById.get(credit.documentId);
    if (!document || classified.has(`credit-${credit.id}`)) continue;
    credit.items.forEach((item) => {
      const original = document.items[item.itemIndex];
      if (!original?.vatCode) { issues.push({ entryId: `credit-${credit.id}`, date: credit.date, reference: credit.number, description: credit.reason, reason: 'Original document has no reviewed VAT code.' }); return; }
      const key = `${document.id}:${item.itemIndex}`;
      const before = creditedByLine.get(key) ?? 0;
      const vatAt = (quantity: number) => Math.round(quantity * original.unitPricePence * original.vatRate / 100);
      const vat = vatAt(before + item.quantity) - vatAt(before);
      creditedByLine.set(key, before + item.quantity);
      addRow({ id: `credit-${credit.id}:${item.itemIndex}`, entryId: `credit-${credit.id}`, taxDate: credit.date, reference: credit.number, description: credit.reason, code: original.vatCode, boxes: negative(vatBoxes(original.vatCode, item.quantity * original.unitPricePence, vat)) });
    });
  }
  for (const posting of sourcePostings) {
    const entryId = `source-${posting.id}`;
    if (classified.has(entryId)) continue;
    if (!posting.vatCode) { issues.push({ entryId, date: posting.taxDate || posting.date, reference: posting.reference, description: posting.description, reason: 'Choose a VAT classification for this older Exdox posting.' }); continue; }
    addRow({ id: entryId, entryId, taxDate: posting.taxDate || posting.date, reference: posting.reference, description: posting.description, code: posting.vatCode, boxes: vatBoxes(posting.vatCode, posting.netPence, posting.vatPence) });
  }
  for (const classification of classifications) {
    const entry = entryById.get(classification.entryId);
    if (entry) addRow({ id: `classification-${classification.id}`, entryId: entry.id, taxDate: classification.taxDate, reference: entry.reference, description: `${entry.description}: ${classification.reason}`, code: 'REVIEWED', boxes: classification.boxes });
  }
  for (const reversal of reversals) {
    if (classified.has(`reversal-${reversal.targetEntryId}`)) continue;
    const originalRows = allRows.filter((row) => row.entryId === reversal.targetEntryId);
    if (!originalRows.length && !reversal.targetEntryId.startsWith('payment-')) issues.push({ entryId: `reversal-${reversal.targetEntryId}`, date: reversal.date, reference: entryById.get(reversal.targetEntryId)?.reference || '', description: reversal.reason, reason: 'The original entry has no reviewed VAT classification.' });
    for (const row of originalRows) addRow({ ...row, id: `reversal-${row.id}`, entryId: `reversal-${reversal.targetEntryId}`, taxDate: reversal.date, description: `Reversal: ${reversal.reason}`, boxes: negative(row.boxes) });
  }
  const classifiedIds = new Set(allRows.map((row) => row.entryId));
  const issueIds = new Set(issues.map((item) => item.entryId));
  for (const entry of entries) {
    if (entry.id.startsWith('reversal-') || entry.id.startsWith('payment-') || classifiedIds.has(entry.id) || issueIds.has(entry.id)) continue;
    issues.push({ entryId: entry.id, date: entry.date, reference: entry.reference, description: entry.description, reason: 'Classify this posting or mark it as excluded from VAT.' });
  }
  const rows = allRows.filter((row) => row.taxDate >= fromDate && row.taxDate <= toDate).sort((a, b) => a.taxDate.localeCompare(b.taxDate) || a.id.localeCompare(b.id));
  const periodIssues = issues.filter((item) => item.date >= fromDate && item.date <= toDate);
  const boxes = emptyVatAmounts();
  for (const row of rows) addAmounts(boxes, row.boxes);
  const summary = { ...boxes, box3: boxes.box1 + boxes.box2, box5: boxes.box1 + boxes.box2 - boxes.box4 };
  const digest = createHash('sha256').update(JSON.stringify({ fromDate, toDate, rows, summary })).digest('hex');
  return { fromDate, toDate, boxes: summary, rows, issues: periodIssues, ready: periodIssues.length === 0, digest };
}

export function createVatClose(report: ReturnType<typeof buildVatReport>, existing: VatClose[], closedBy: string): VatClose {
  if (report.toDate > new Date().toISOString().slice(0, 10)) throw new Error('Wait until the VAT period has ended before closing it.');
  if (!report.ready) throw new Error('Classify every VAT-relevant posting in this period before closing it.');
  if (existing.some((item) => report.fromDate <= item.toDate && report.toDate >= item.fromDate)) throw new Error('This VAT period overlaps a period that is already closed.');
  return { id: randomUUID(), fromDate: report.fromDate, toDate: report.toDate, boxes: report.boxes, digest: report.digest, rowCount: report.rows.length, closedAt: new Date().toISOString(), closedBy };
}
