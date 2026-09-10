import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const unlock = readFileSync(new URL('../src/aws/shared/accountingIntegrationUnlock.ts', import.meta.url), 'utf8');
const webhook = readFileSync(new URL('../src/aws/handlers/stripeWebhook.ts', import.meta.url), 'utf8');

test('trial accounting integration unlock has explicit payment and confirmation routes', () => {
  assert.match(template, /Path: \/billing\/accounting-integration-unlock\/checkout-session/);
  assert.match(template, /Path: \/billing\/accounting-integration-unlock\/confirm/);
  assert.match(template, /StripeWebhookFunction:[\s\S]*?S3CrudPolicy/);
});

test('£5 unlock payment creates one matching credit on the subscribed first invoice', () => {
  assert.match(unlock, /ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE = 500/);
  assert.match(unlock, /mode: 'payment'/);
  assert.match(unlock, /amount: -ACCOUNTING_INTEGRATION_UNLOCK_PRICE_PENCE/);
  assert.match(unlock, /subscription: metadataSubscriptionId/);
  assert.match(unlock, /accounting-integration-unlock-credit-\$\{session\.id\}/);
  assert.match(unlock, /billing\.status !== 'trialing'/);
  assert.match(unlock, /removeUnusedAccountingIntegrationCredit/);
  assert.match(unlock, /invoiceItems\.del/);
});

test('Stripe webhook fulfils accounting unlocks and asks Stripe to retry failures', () => {
  assert.match(webhook, /checkout\.session\.async_payment_succeeded/);
  assert.match(webhook, /fulfillAccountingIntegrationUnlock/);
  assert.match(webhook, /accounting_integration_fulfillment_failed/);
  assert.match(webhook, /jsonResponse\(500/);
});
