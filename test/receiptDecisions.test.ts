import assert from 'node:assert/strict';
import test from 'node:test';

import { decisionFromReceipt, isUnreviewedCost } from '../src/aws/shared/receiptDecisionPolicy.js';
import type { ReceiptRow } from '../src/aws/types.js';

test('only purchases awaiting review qualify for an admin decision notice', () => {
  assert.equal(isUnreviewedCost({ workspaceContext: 'cost', status: 'Review', claimId: null }), true);
  assert.equal(isUnreviewedCost({ workspaceContext: 'cost', status: 'Processing', claimId: null }), true);
  assert.equal(isUnreviewedCost({ workspaceContext: 'cost', status: 'Ready', claimId: null }), true);
  assert.equal(isUnreviewedCost({ workspaceContext: 'cost', status: 'Ready', claimId: 42 }), false);
  assert.equal(isUnreviewedCost({ workspaceContext: 'cost', status: 'Paid', claimId: null }), false);
  assert.equal(isUnreviewedCost({ workspaceContext: 'sales', status: 'Review', claimId: null }), false);
});

test('decision preserves the uploader, vendor and purchase details for the employee', () => {
  const receipt = {
    id: 42,
    organisationId: 7,
    uploadedByUserId: 12,
    workspaceContext: 'cost',
    status: 'Review',
    documentType: 'invoice',
    vendorName: 'Acme Supplies',
    sourceFilename: 'invoice.pdf',
    totalAmount: 18.5,
    currency: 'USD',
    baseCurrency: 'USD',
    createdAt: '2026-10-01T10:00:00.000Z',
  } as ReceiptRow;
  const decision = decisionFromReceipt(receipt, 'deleted');
  assert.deepEqual({
    receiptId: decision.receiptId,
    organisationId: decision.organisationId,
    uploadedByUserId: decision.uploadedByUserId,
    action: decision.action,
    documentType: decision.documentType,
    vendorName: decision.vendorName,
    amount: decision.amount,
    currency: decision.currency,
  }, {
    receiptId: 42,
    organisationId: 7,
    uploadedByUserId: 12,
    action: 'deleted',
    documentType: 'invoice',
    vendorName: 'Acme Supplies',
    amount: 18.5,
    currency: 'USD',
  });
});
