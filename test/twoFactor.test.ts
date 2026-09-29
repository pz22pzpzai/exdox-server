import assert from 'node:assert/strict';
import test from 'node:test';

process.env.RECEIPT_BUCKET_NAME ||= 'two-factor-test';
process.env.OPENAI_API_KEY ||= 'two-factor-test';
process.env.JWT_SECRET ||= 'two-factor-test';

const { generateTotpCode } = await import('../src/aws/shared/twoFactor.js');

test('authenticator codes follow the standard 30-second SHA-1 test vectors', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(generateTotpCode(secret, 1), '287082');
  assert.equal(generateTotpCode(secret, 37_037_036), '081804');
});
