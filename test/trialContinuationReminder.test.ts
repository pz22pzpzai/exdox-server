import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { trialReminderKind } from '../src/aws/shared/trialReminderPolicy.js';

const reminder = readFileSync(new URL('../src/aws/shared/trialContinuationReminder.ts', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../src/aws/handlers/sendTrialContinuationReminders.ts', import.meta.url), 'utf8');
const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');

test('trial reminders target unpaid trials near expiry and recently paused trials only once', () => {
  const now = Date.UTC(2026, 8, 20, 12);
  const subscription = (status: 'trialing' | 'paused' | 'active', daysFromNow: number, organisationId = '42') => ({
    status, trial_end: Math.floor(now / 1000) + daysFromNow * 86400, metadata: { organisationId },
  });
  assert.equal(trialReminderKind(subscription('trialing', 2), now), 'ending');
  assert.equal(trialReminderKind(subscription('trialing', 5), now), null);
  assert.equal(trialReminderKind(subscription('trialing', -1), now), null);
  assert.equal(trialReminderKind(subscription('paused', -1), now), 'ended');
  assert.equal(trialReminderKind(subscription('paused', -8), now), null);
  assert.equal(trialReminderKind(subscription('active', -1), now), null);
  assert.equal(trialReminderKind(subscription('paused', -1, ''), now), null);
  assert.match(reminder, /kind === 'ending' && hasPaymentMethod\(subscription, customer\)/);
  assert.match(reminder, /await alreadySent\(subscription\.id, kind\)/);
  assert.match(reminder, /loginUrl\.searchParams\.set\('trial', kind\)/);
  assert.match(reminder, /await putReceiptJsonObject\(reminderKey\(subscription\.id, kind\)/);
});

test('daily reminder job uses its own scheduled function with email and storage permissions', () => {
  assert.match(handler, /\['trialing', 'paused'\]/);
  assert.match(handler, /sendTrialContinuationReminder\(subscription, stripe\)/);
  assert.match(template, /SendTrialContinuationRemindersFunction:[\s\S]*?Schedule: rate\(1 day\)/);
  assert.match(template, /SendTrialContinuationRemindersFunction:[\s\S]*?ses:SendEmail/);
});
