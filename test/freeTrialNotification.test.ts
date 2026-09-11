import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const webhook = readFileSync(new URL('../src/aws/handlers/stripeWebhook.ts', import.meta.url), 'utf8');
const notification = readFileSync(new URL('../src/aws/shared/freeTrialNotification.ts', import.meta.url), 'utf8');

test('confirmed Stripe trial creation sends one internal signup email', () => {
  assert.match(webhook, /customer\.subscription\.created/);
  assert.match(webhook, /sendFreeTrialStartedNotification/);
  assert.match(notification, /subscription\.status !== 'trialing'/);
  assert.match(notification, /billing-notifications\/free-trials\/\$\{subscriptionId\}\.json/);
  assert.match(notification, /reason: 'already_sent'/);
  assert.match(notification, /ToAddresses: \[awsEnv\.contactInboxEmail\]/);
});

test('trial email contains business owner plan and allowance context without payment details', () => {
  for (const label of ['Business:', 'Owner:', 'Owner email:', 'Plan:', 'Trial started:', 'Trial ends:', 'Included users:', 'Monthly document allowance:']) {
    assert.match(notification, new RegExp(label));
  }
  assert.doesNotMatch(notification, /card number|payment method|last four/i);
  assert.match(template, /StripeWebhookFunction:[\s\S]*?ses:SendEmail/);
  assert.match(webhook, /free_trial_notification_failed/);
});
