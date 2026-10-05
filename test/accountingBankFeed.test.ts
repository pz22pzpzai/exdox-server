import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeFeedTransaction } from '../src/aws/shared/accountingBankFeed.js';
import { liveBankFeedAllowed } from '../src/aws/shared/liveBankFeedAccess.js';

const connection = '0a6273a0-0314-4db6-800a-e66225fbe9f7';
const bank = '9b7383a0-0314-4db6-800a-e66225fbe8a6';

test('live bank feeds need explicit regulatory approval as well as production provider credentials', () => {
  assert.equal(liveBankFeedAllowed('production', false, 'live-id', 'live-secret'), false);
  assert.equal(liveBankFeedAllowed('sandbox', true, 'live-id', 'live-secret'), false);
  assert.equal(liveBankFeedAllowed('production', true, null, 'live-secret'), false);
  assert.equal(liveBankFeedAllowed('production', true, 'live-id', 'live-secret'), true);
});

test('settled GBP feed transactions retain signed pence and stable import identity', () => {
  const row = { id: 'provider-transaction-1', timestamp: '2026-10-04T12:34:56Z', description: 'BANK FEE', currency: 'GBP', amount_in_minor: -4200, status: 'settled' };
  const first = normalizeFeedTransaction(row, connection, bank, '1000');
  const second = normalizeFeedTransaction(row, connection, bank, '1000');
  assert.equal(first?.amountPence, -4200);
  assert.equal(first?.date, '2026-10-04');
  assert.equal(first?.id, second?.id);
  assert.notEqual(first?.id, normalizeFeedTransaction(row, connection, '00000000-0000-0000-0000-000000000001', '1000')?.id);
});

test('pending feed rows are skipped and malformed settled money is rejected', () => {
  const row = { id: 'provider-transaction-2', timestamp: '2026-10-04T12:34:56Z', description: 'CARD', currency: 'GBP', amount_in_minor: 1200, status: 'settled' };
  assert.equal(normalizeFeedTransaction({ ...row, status: 'pending' }, connection, bank, '1000'), null);
  assert.throws(() => normalizeFeedTransaction({ ...row, amount_in_minor: 1.5 }, connection, bank, '1000'), /incomplete GBP/);
  assert.throws(() => normalizeFeedTransaction({ ...row, currency: 'EUR' }, connection, bank, '1000'), /incomplete GBP/);
  assert.throws(() => normalizeFeedTransaction({ ...row, status: 'unknown' }, connection, bank, '1000'), /unknown status/);
});
