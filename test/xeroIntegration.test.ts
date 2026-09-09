import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../src/aws/handlers/xero.ts', import.meta.url), 'utf8');

test('Xero integration exposes explicit admin connection, settings, reference, and publishing routes', () => {
  for (const path of ['/xero/status', '/xero/connect', '/xero/callback', '/xero/tenant', '/xero/reference-data', '/xero/settings', '/xero/customers/sync', '/xero/customers/import', '/xero/publish']) {
    assert.match(template, new RegExp(`Path: ${path.replaceAll('/', '\\/')}`));
  }
  assert.match(handler, /requireAdminUser\(user\)/);
});

test('Xero tokens and publication records are protected and duplicate-safe', () => {
  assert.match(handler, /aes-256-gcm/);
  assert.match(handler, /offline_access/);
  assert.match(handler, /accounting\.attachments/);
  assert.match(handler, /loadPublication/);
  assert.match(handler, /alreadyPublished: true/);
});
