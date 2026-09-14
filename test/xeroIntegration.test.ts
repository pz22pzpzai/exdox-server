import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../src/aws/handlers/xero.ts', import.meta.url), 'utf8');
const accountingAccess = readFileSync(new URL('../src/aws/shared/accountingIntegrationUnlock.ts', import.meta.url), 'utf8');

test('Xero integration exposes explicit admin connection, settings, reference, and publishing routes', () => {
  for (const path of ['/xero/status', '/xero/connect', '/xero/callback', '/xero/tenant', '/xero/reference-data', '/xero/settings', '/xero/customers/sync', '/xero/customers/import', '/xero/publish']) {
    assert.match(template, new RegExp(`Path: ${path.replaceAll('/', '\\/')}`));
  }
  assert.match(handler, /requireAdminUser\(user\)/);
  assert.match(handler, /requirePaidXeroAccess/);
  assert.match(handler, /getAccountingIntegrationAccess/);
  assert.match(handler, /if \(!access\.available\)/);
  assert.match(template, /ConnectXeroFunction:[\s\S]*?s3:GetObject[\s\S]*?ReceiptBucketName\}\/organisations\/\*/);
  assert.match(template, /ReceiptBucketName\}\/billing-addons\/\*/);
});

test('Xero connect billing access avoids bucket-wide S3 listing', () => {
  const accessGate = accountingAccess.match(/export async function getAccountingIntegrationAccess[\s\S]*?\n\}/)?.[0];
  assert.ok(accessGate, 'Expected the accounting integration access gate to exist.');
  assert.match(accessGate, /getOrganisationBillingAccessState\(organisationId\)/);
  assert.doesNotMatch(accessGate, /getOrganisationBillingSummary\(organisationId\)/);

  const connectFunction = template.match(/  ConnectXeroFunction:[\s\S]*?(?=\n  XeroCallbackFunction:)/)?.[0];
  assert.ok(connectFunction, 'Expected the ConnectXeroFunction template block to exist.');
  assert.match(connectFunction, /s3:GetObject/);
  assert.doesNotMatch(connectFunction, /s3:ListBucket/);
});

test('Xero tokens and publication records are protected and duplicate-safe', () => {
  assert.match(handler, /aes-256-gcm/);
  assert.match(handler, /offline_access/);
  assert.match(handler, /accounting\.attachments/);
  assert.match(handler, /loadPublication/);
  assert.match(handler, /alreadyPublished: true/);
  assert.match(handler, /BankTransactions/);
  assert.match(handler, /categoryAccountMappings/);
  assert.match(handler, /taxTypeMappings/);
});
