import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const checkout = readFileSync(new URL('../src/aws/shared/billingCheckout.ts', import.meta.url), 'utf8');
const login = readFileSync(new URL('../src/aws/handlers/login.ts', import.meta.url), 'utf8');
const subscription = readFileSync(new URL('../src/aws/shared/stripeSubscription.ts', import.meta.url), 'utf8');

test('initial Checkout starts a card-free trial and pauses it if unpaid', () => {
  assert.match(checkout, /payment_method_collection: startsTrial \? 'if_required' : 'always'/);
  assert.match(checkout, /startsTrial && planDefinition\.trialDays \? \{ trial_period_days: planDefinition\.trialDays \}/);
  assert.match(checkout, /missing_payment_method: 'pause'/);
  assert.match(checkout, /billing\.status === 'inactive' && !billing\.trialEndsAt && !billing\.stripeSubscriptionId/);
});

test('post-trial Checkout takes payment without restarting the trial and retains the £5 credit', () => {
  assert.match(checkout, /checkoutPurpose: startsTrial \? 'trial_start' : 'paid_continuation'/);
  assert.match(checkout, /hasUnusedAccountingIntegrationCredit/);
  assert.match(checkout, /discounts: \[\{ coupon: coupon\.id \}\]/);
  assert.match(checkout, /finishPaidContinuation/);
  assert.match(checkout, /removeUnusedAccountingIntegrationCredit/);
  assert.match(login, /requiresBillingCheckout: true/);
  assert.match(subscription, /currentSubscription\.status === 'paused'/);
});
