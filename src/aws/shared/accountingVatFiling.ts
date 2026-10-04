import type { VatClose } from './accountingVat.js';
import { buildVatReport } from './accountingVat.js';

type VatReport = ReturnType<typeof buildVatReport>;

// A filing preview is never a submission. HMRC supplies the period key from an
// open obligation, and the legal declaration must be made immediately before POST.
export function buildVatFilingPreview(report: VatReport, closes: VatClose[]) {
  const close = closes.find((item) => item.fromDate === report.fromDate && item.toDate === report.toDate);
  const blockers: string[] = [];
  if (report.toDate > new Date().toISOString().slice(0, 10)) blockers.push('The VAT period has not ended.');
  if (!report.ready) blockers.push(`${report.issues.length} accounting item(s) still need VAT classification.`);
  if (!close) blockers.push('Close the reviewed VAT period in Accounting first.');
  else if (close.digest !== report.digest || JSON.stringify(close.boxes) !== JSON.stringify(report.boxes)) blockers.push('The current VAT evidence differs from the closed snapshot.');

  const boxes = report.boxes;
  if (boxes.box3 !== boxes.box1 + boxes.box2 || boxes.box5 !== boxes.box3 - boxes.box4) blockers.push('VAT box totals do not reconcile.');
  if (Object.values(boxes).some((value) => !Number.isSafeInteger(value) || Math.abs(value) > 9_999_999_999_999)) blockers.push('A VAT box is outside the supported monetary range.');
  if ([boxes.box1, boxes.box2, boxes.box3, boxes.box4, boxes.box6, boxes.box7, boxes.box8, boxes.box9].some((value) => value < 0)) blockers.push('A VAT box is negative. Review credit notes and corrections before preparing an HMRC return.');
  if (boxes.box8 > boxes.box6 || boxes.box9 > boxes.box7) blockers.push('Northern Ireland goods values exceed the related sales or purchase totals.');

  const pounds = (pence: number) => Number((pence / 100).toFixed(2));
  const wholePounds = (pence: number) => Math.round(pence / 100);
  const fields = {
    vatDueSales: pounds(boxes.box1),
    vatDueAcquisitions: pounds(boxes.box2),
    totalVatDue: pounds(boxes.box3),
    vatReclaimedCurrPeriod: pounds(boxes.box4),
    netVatDue: pounds(Math.abs(boxes.box5)),
    totalValueSalesExVAT: wholePounds(boxes.box6),
    totalValuePurchasesExVAT: wholePounds(boxes.box7),
    totalValueGoodsSuppliedExVAT: wholePounds(boxes.box8),
    totalAcquisitionsExVAT: wholePounds(boxes.box9),
  };
  return {
    fromDate: report.fromDate,
    toDate: report.toDate,
    sourceDigest: report.digest,
    closedAt: close?.closedAt ?? null,
    internallyReady: blockers.length === 0,
    blockers,
    fields,
    submissionAvailable: false,
    connectionMessage: 'HMRC VAT (MTD) is not connected. An open HMRC obligation, its period key, user authorisation, compliant fraud prevention headers, and production approval are required before submission.',
  };
}
