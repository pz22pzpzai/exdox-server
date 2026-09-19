import assert from 'node:assert/strict';
import test from 'node:test';

// The billing module reads AWS configuration on import; these inert values
// allow its pure selection logic to be tested without production credentials.
process.env.RECEIPT_BUCKET_NAME ||= 'billing-selection-test';
process.env.OPENAI_API_KEY ||= 'billing-selection-test';
process.env.JWT_SECRET ||= 'billing-selection-test';
const { resolveSelfServeSubscriptionSelection } = await import('../src/aws/shared/billing.js');

test('one-user Capture selection bills £10 monthly with 100 documents', () => {
  assert.deepEqual(resolveSelfServeSubscriptionSelection({
    planId: 'capture',
    includedUsers: 1,
    monthlyDocumentLimit: 100,
  }), {
    planId: 'capture',
    includedUsers: 1,
    monthlyDocumentLimit: 100,
    monthlyAmountPence: 1000,
    label: 'Capture - 1 user',
  });
});

test('existing five-user Capture price remains £15', () => {
  const selection = resolveSelfServeSubscriptionSelection({
    planId: 'capture',
    includedUsers: 5,
    monthlyDocumentLimit: 250,
  });
  assert.equal(selection.monthlyAmountPence, 1500);
});

test('unsupported one-user allowances and plan combinations are rejected', () => {
  for (const input of [
    { planId: 'capture', includedUsers: 1, monthlyDocumentLimit: 50 },
    { planId: 'capture', includedUsers: 1, monthlyDocumentLimit: 250 },
    { planId: 'control', includedUsers: 1, monthlyDocumentLimit: 100 },
  ] as const) {
    assert.throws(() => resolveSelfServeSubscriptionSelection(input), {
      message: /selected plan allowance is not available/i,
    });
  }
});
