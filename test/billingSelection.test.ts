import assert from 'node:assert/strict';
import test from 'node:test';

// The billing module reads AWS configuration on import; these inert values
// allow its pure selection logic to be tested without production credentials.
process.env.RECEIPT_BUCKET_NAME ||= 'billing-selection-test';
process.env.OPENAI_API_KEY ||= 'billing-selection-test';
process.env.JWT_SECRET ||= 'billing-selection-test';
const {
  buildEntitlements,
  canAccessWorkspace,
  hasFeature,
  resolveAllowedWebRoutes,
  resolveSelfServeSubscriptionSelection,
} = await import('../src/aws/shared/billing.js');
import type { OrganisationBillingSummary } from '../src/aws/types.js';

function billingFor(planId: OrganisationBillingSummary['planId'], status: OrganisationBillingSummary['status'] = 'active'): OrganisationBillingSummary {
  return {
    planId,
    status,
    billingCycle: 'monthly',
    trialEndsAt: null,
    billingPeriodStartedAt: null,
    billingPeriodEndsAt: null,
    monthlyDocumentLimit: 100,
    monthlyDocumentUsage: 0,
    includedUsers: 1,
    currentUserCount: 1,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    cancellationScheduledFor: null,
  };
}

test('every self-serve plan unlocks both rule areas and Vault while retaining role and billing gates', () => {
  for (const planId of ['capture', 'control', 'operations'] as const) {
    const billing = billingFor(planId);
    const adminRoutes = resolveAllowedWebRoutes(billing, 'Business_Admin');
    const employeeRoutes = resolveAllowedWebRoutes(billing, 'Standard_Employee');
    assert.ok(adminRoutes.includes('/rules'));
    assert.ok(adminRoutes.includes('/vault'));
    assert.ok(employeeRoutes.includes('/employee/vault'));
    assert.ok(!employeeRoutes.includes('/rules'));
    assert.ok(!employeeRoutes.includes('/vault'));
    assert.ok(hasFeature(billing, 'supplier_rules'));
    assert.ok(hasFeature(billing, 'archive_access'));
    assert.ok(canAccessWorkspace(billing, 'vault'));
    assert.ok(!buildEntitlements(billing).lockedRoutes.includes('/vault'));
    assert.ok(!hasFeature(billingFor(planId, 'inactive'), 'supplier_rules'));
    assert.ok(!canAccessWorkspace(billingFor(planId, 'inactive'), 'vault'));
  }
});

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
