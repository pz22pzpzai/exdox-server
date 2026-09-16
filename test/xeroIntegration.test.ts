import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../src/aws/handlers/xero.ts', import.meta.url), 'utf8');
const accountingAccess = readFileSync(new URL('../src/aws/shared/accountingIntegrationUnlock.ts', import.meta.url), 'utf8');
const reimbursementExport = readFileSync(new URL('../src/aws/handlers/exportEmployeeReimbursements.ts', import.meta.url), 'utf8');
const reimbursementPaid = readFileSync(new URL('../src/aws/handlers/markEmployeeReimbursementsPaid.ts', import.meta.url), 'utf8');

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

test('Xero connect billing access uses the lightweight lookup with a bucket-only legacy listing fallback', () => {
  const accessGate = accountingAccess.match(/export async function getAccountingIntegrationAccess[\s\S]*?\n\}/)?.[0];
  assert.ok(accessGate, 'Expected the accounting integration access gate to exist.');
  assert.match(accessGate, /getOrganisationBillingAccessState\(organisationId\)/);
  assert.doesNotMatch(accessGate, /getOrganisationBillingSummary\(organisationId\)/);

  const connectFunction = template.match(/  ConnectXeroFunction:[\s\S]*?(?=\n  XeroCallbackFunction:)/)?.[0];
  assert.ok(connectFunction, 'Expected the ConnectXeroFunction template block to exist.');
  assert.match(connectFunction, /s3:GetObject/);
  assert.match(connectFunction, /s3:ListBucket/);
  assert.doesNotMatch(connectFunction, /s3:prefix:/);
  assert.doesNotMatch(connectFunction, /S3CrudPolicy/);
});

test('Xero tokens and publication records are protected and duplicate-safe', () => {
  assert.match(handler, /aes-256-gcm/);
  assert.match(handler, /offline_access/);
  assert.match(handler, /accounting\.attachments/);
  assert.match(handler, /loadPublication/);
  assert.match(handler, /alreadyPublished: true/);
  assert.match(handler, /BankTransactions/);
  assert.match(handler, /categoryAccountMappings/);
  assert.match(handler, /purchaseTaxTypeMappings/);
  assert.match(handler, /salesTaxTypeMappings/);
  assert.match(handler, /const taxTypeMappings = isCost \? settings\.purchaseTaxTypeMappings : settings\.salesTaxTypeMappings/);
  assert.match(handler, /Repair the visible Exdox state/);
});

test('Xero reference refresh stays below the tenant concurrency limit and handles temporary failures', () => {
  const referenceHandler = handler.match(/export async function referenceDataHandler[\s\S]*?\n\}/)?.[0];
  assert.ok(referenceHandler, 'Expected the Xero reference-data handler to exist.');
  const requestWaves = [...referenceHandler.matchAll(/Promise\.all\(\[([\s\S]*?)\]\)/g)];
  assert.ok(requestWaves.length >= 3, 'Expected reference data to be loaded in bounded waves.');
  for (const [, wave] of requestWaves) {
    const xeroRequests = (wave.match(/xeroGetWithAuth|loadXeroContacts/g) ?? []).length;
    assert.ok(xeroRequests <= 3, `Expected no more than three concurrent Xero requests, found ${xeroRequests}.`);
  }
  assert.match(handler, /response\.status === 429/);
  assert.match(handler, /response\.headers\.get\('retry-after'\)/);
  assert.match(handler, /xero_temporarily_unavailable/);
  assert.doesNotMatch(handler, /if \(!response\.ok\) throw new Error\('Xero could not refresh the requested accounting data\. Reconnect Xero and try again\.'\)/);
});

test('manual reimbursement and Xero publication keep distinct final states', () => {
  assert.match(reimbursementExport, /selectedReceiptIds/);
  assert.match(reimbursementExport, /receipt\.status === 'Ready'/);
  assert.match(reimbursementExport, /receipt\.status === 'Published'/);
  assert.doesNotMatch(reimbursementExport, /updateReimbursementPaymentStatus\(user, 'Ready', 'Payment processing'/);
  assert.match(reimbursementExport, /markReimbursementProcessingStarted\(user, includedReceiptIds, reimbursementBatch\)/);
  assert.match(reimbursementExport, /paymentProcessingCount/);
  assert.match(reimbursementPaid, /updateReimbursementPaymentStatus\(user, 'Ready', 'Paid'\)/);
  assert.match(reimbursementPaid, /updateReimbursementPaymentStatus\(user, 'Payment processing', 'Paid'\)/);
});
