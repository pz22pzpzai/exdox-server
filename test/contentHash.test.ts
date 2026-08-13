import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateContentSha256, contentHashesMatch } from '../src/aws/shared/contentHash.js';

test('content hash is stable for identical bytes regardless of filename', () => {
  const first = calculateContentSha256(Buffer.from('same receipt bytes'));
  const second = calculateContentSha256(Buffer.from('same receipt bytes'));

  assert.equal(first, second);
  assert.equal(contentHashesMatch(first, second), true);
});

test('content hash rejects changed bytes and malformed values', () => {
  const first = calculateContentSha256(Buffer.from('receipt A'));
  const second = calculateContentSha256(Buffer.from('receipt B'));

  assert.equal(contentHashesMatch(first, second), false);
  assert.equal(contentHashesMatch(first, 'not-a-sha256'), false);
  assert.equal(contentHashesMatch(null, first), false);
});
