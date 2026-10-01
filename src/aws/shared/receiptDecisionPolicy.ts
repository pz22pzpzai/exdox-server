import type { ReceiptRow } from '../types.js';

export type ReceiptDecision = {
  receiptId: number;
  organisationId: number;
  uploadedByUserId: number;
  action: 'deleted' | 'rejected';
  documentType: 'receipt' | 'invoice';
  vendorName: string;
  sourceFilename: string;
  amount: number | null;
  currency: string;
  createdAt: string;
  decidedAt: string;
};

export function isUnreviewedCost(receipt: Pick<ReceiptRow, 'workspaceContext' | 'status' | 'claimId'>) {
  // A receipt can reach Ready from OCR without a person reviewing it. Once it
  // enters a claim or a final payment/publication state it is no longer here.
  return receipt.workspaceContext === 'cost'
    && receipt.claimId === null
    && (receipt.status === 'Review' || receipt.status === 'Processing' || receipt.status === 'Ready');
}

export function decisionFromReceipt(receipt: ReceiptRow, action: ReceiptDecision['action']): ReceiptDecision {
  return {
    receiptId: receipt.id,
    organisationId: receipt.organisationId,
    uploadedByUserId: receipt.uploadedByUserId,
    action,
    documentType: receipt.documentType === 'invoice' ? 'invoice' : 'receipt',
    vendorName: receipt.vendorName?.trim() || receipt.sourceFilename.replace(/\.[^/.]+$/, '') || 'Expense',
    sourceFilename: receipt.sourceFilename,
    amount: receipt.totalAmount,
    currency: receipt.currency || receipt.baseCurrency || 'GBP',
    createdAt: receipt.createdAt,
    decidedAt: new Date().toISOString(),
  };
}
