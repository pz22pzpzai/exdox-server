import type { JournalEntry } from './accounting.js';
import type { ReceiptRow } from '../types.js';
import { validVatDate, validateVatCode, type VatCode } from './accountingVat.js';

export type SourcePosting = { id: string; sourceType: 'receipt'; sourceId: number; workspaceContext: 'cost' | 'sales'; sourceUpdatedAt: string; date: string; taxDate?: string; vatCode?: VatCode; description: string; reference: string; netPence: number; vatPence: number; totalPence: number; createdAt: string; createdBy: string };

function pence(value: number | null, label: string) {
  if (value === null || !Number.isFinite(value)) throw new Error(`${label} is missing. Review the Exdox record first.`);
  const amount = Math.round(value * 100);
  if (!Number.isSafeInteger(amount) || Math.abs(value * 100 - amount) > 0.00001) throw new Error(`${label} must have no more than two decimal places.`);
  return amount;
}

export function createSourcePosting(receipt: ReceiptRow, organisationCountry: string, createdBy: string, vatCode?: VatCode, taxDate?: string): SourcePosting {
  if (organisationCountry !== 'GB' || receipt.baseCurrency !== 'GBP' || (receipt.currency && receipt.currency !== 'GBP')) throw new Error('Only UK workspaces and GBP source records can be posted to this GBP accounting ledger.');
  if (receipt.workspaceContext !== 'cost' && receipt.workspaceContext !== 'sales') throw new Error('Only Cost and Sales records can be posted.');
  if (!['Ready', 'Published', 'Paid'].includes(receipt.status) || receipt.needsReview) throw new Error('Review and approve this Exdox record before posting it.');
  if (receipt.mileageClaimId) throw new Error('Mileage claims need their own accounting mapping.');
  const totalPence = pence(receipt.totalAmount, 'Total');
  const vatPence = receipt.vatAmount === null && ['No VAT', 'Exempt', '0% Zero'].includes(receipt.taxRateApplied ?? '') ? 0 : pence(receipt.vatAmount, 'VAT');
  const netPence = receipt.netAmount === null ? totalPence - vatPence : pence(receipt.netAmount, 'Net');
  if (totalPence <= 0 || netPence < 0 || vatPence < 0 || netPence + vatPence !== totalPence) throw new Error('Total must be positive and equal net plus VAT. Correct the Exdox record before posting.');
  const date = receipt.invoiceDate || receipt.createdAt.slice(0, 10);
  const parsed = new Date(`${date}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('Exdox record has no valid accounting date.');
  if (vatCode) {
    const rate = vatCode.endsWith('20') ? 20 : vatCode.endsWith('5') ? 5 : 0;
    validateVatCode(vatCode, receipt.workspaceContext, rate as 0 | 5 | 20);
    if (vatPence !== Math.round(netPence * rate / 100)) throw new Error('This record has mixed or unsupported VAT amounts for the selected code. Classify it through a reviewed manual journal.');
  }
  if (taxDate && !validVatDate(taxDate)) throw new Error('Enter a valid VAT tax date.');
  return {
    id: `receipt-${receipt.id}`, sourceType: 'receipt', sourceId: receipt.id, workspaceContext: receipt.workspaceContext,
    sourceUpdatedAt: receipt.updatedAt, date, taxDate: taxDate || date, vatCode,
    description: `${receipt.workspaceContext === 'cost' ? 'Cost' : 'Sale'}: ${receipt.vendorName || receipt.customer || receipt.description || receipt.sourceFilename}`.slice(0, 240),
    reference: receipt.invoiceNumber || String(receipt.id), netPence, vatPence, totalPence,
    createdAt: new Date().toISOString(), createdBy,
  };
}

export function sourceJournal(posting: SourcePosting): JournalEntry {
  const sale = posting.workspaceContext === 'sales';
  const lines = sale ? [
    { accountId: '1100', debitPence: posting.totalPence, creditPence: 0 },
    { accountId: '4000', debitPence: 0, creditPence: posting.netPence },
    ...(posting.vatPence ? [{ accountId: '2100', debitPence: 0, creditPence: posting.vatPence }] : []),
  ] : [
    { accountId: '6000', debitPence: posting.netPence, creditPence: 0 },
    ...(posting.vatPence ? [{ accountId: '1200', debitPence: posting.vatPence, creditPence: 0 }] : []),
    { accountId: '2000', debitPence: 0, creditPence: posting.totalPence },
  ];
  return { id: `source-${posting.id}`, date: posting.date, reference: posting.reference, description: posting.description, lines, createdAt: posting.createdAt, createdBy: posting.createdBy };
}
