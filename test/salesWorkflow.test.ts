import assert from 'node:assert/strict';
import test from 'node:test';

import { canChangeSalesStatus, isSalesStatus } from '../src/aws/shared/salesWorkflow.js';

test('sales workflow accepts only sales lifecycle statuses', () => {
  for (const status of ['Processing', 'Review', 'Ready', 'Published', 'Paid', 'Rejected']) {
    assert.equal(isSalesStatus(status), true);
  }
  for (const status of ['Payment processing', 'submitted', 'ready_to_submit', '']) {
    assert.equal(isSalesStatus(status), false);
  }
});

test('only business admins can change a sales workflow status', () => {
  assert.equal(canChangeSalesStatus('Business_Admin', 'Review', 'Ready'), true);
  assert.equal(canChangeSalesStatus('Business_Admin', 'Published', 'Paid'), true);
  assert.equal(canChangeSalesStatus('Standard_Employee', 'Review', 'Ready'), false);
  assert.equal(canChangeSalesStatus('Standard_Employee', 'Review', 'Review'), true);
});
