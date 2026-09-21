import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const webhook = readFileSync(new URL('../src/aws/handlers/stripeWebhook.ts', import.meta.url), 'utf8');
const register = readFileSync(new URL('../src/aws/handlers/register.ts', import.meta.url), 'utf8');
const notification = readFileSync(new URL('../src/aws/shared/freeTrialNotification.ts', import.meta.url), 'utf8');

test('registration sends the internal signup email immediately and Stripe remains an idempotent fallback', () => {
  assert.match(register, /sendNewWorkspaceSignupNotificationWithRetry/);
  assert.match(register, /source: 'registration'/);
  assert.match(webhook, /customer\.subscription\.created/);
  assert.match(webhook, /sendFreeTrialStartedNotification/);
  assert.match(notification, /subscription\.status !== 'trialing'/);
  assert.match(notification, /billing-notifications\/free-trials\/organisation-\$\{organisationId\}\.json/);
  assert.match(notification, /legacyNotificationKey/);
  assert.match(notification, /reason: 'already_sent'/);
  assert.match(notification, /ToAddresses: \[awsEnv\.contactInboxEmail\]/);
  assert.match(notification, /attempts = 3/);
});

test('trial email contains business owner plan and allowance context without payment details', () => {
  for (const label of ['Business:', 'Owner:', 'Owner email:', 'Plan:', 'Trial started:', 'Trial ends:', 'Included users:', 'Monthly document allowance:']) {
    assert.match(notification, new RegExp(label));
  }
  assert.doesNotMatch(notification, /card number|payment method|last four/i);
  assert.match(template, /StripeWebhookFunction:[\s\S]*?ses:SendEmail/);
  assert.match(webhook, /free_trial_notification_failed/);
});
