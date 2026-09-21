import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const database = readFileSync(new URL('../src/aws/shared/db.ts', import.meta.url), 'utf8');
const handler = readFileSync(new URL('../src/aws/handlers/deleteAccount.ts', import.meta.url), 'utf8');
const salesWorkspace = readFileSync(new URL('../src/aws/shared/salesWorkspaceStore.ts', import.meta.url), 'utf8');

test('workspace deletion covers every organisation-scoped S3 data family', () => {
  const deletion = database.match(/export async function deleteOrganisationAccount[\s\S]*?return \{ success: true \};\n\}/)?.[0];
  assert.ok(deletion, 'Expected the organisation deletion routine to exist.');

  for (const prefix of [
    'organisations/',
    'receipt-records/org-',
    'receipts/org-',
    'vault/org-',
    'incoming/org-',
    'expense-claims/org-',
    'claim-evidence/org-',
    'recycle-bin/org-',
    'supplier-rules/org-',
    'company-cards/org-',
    'company-card-exceptions/org-',
    'departments/org-',
    'xero-connections/org-',
    'xero-publications/org-',
    'billing-addons/org-',
    'billing-notifications/free-trials/organisation-',
  ]) {
    assert.match(deletion, new RegExp(prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(deletion, /deleteReceiptPrefix\(buildOrganisationUserPointerPrefix\(organisationId\)\)/);
  assert.match(deletion, /billing-notifications\/trial-continuation\/\$\{billingIdentifiers\.stripeSubscriptionId\}-/);
});

test('workspace deletion removes sales records and private inbound address token lookups', () => {
  assert.match(handler, /deleteSalesWorkspaceForOrganisation\(authenticatedUser\.organisationId\)/);
  assert.match(salesWorkspace, /deleteReceiptPrefix\(`\$\{SALES_ROOT\}\/org-\$\{organisationId\}\/`\)/);
  assert.match(salesWorkspace, /entry\?\.address\.organisationId === organisationId/);
  assert.match(salesWorkspace, /deleteReceiptPrefix\(entry\.key\)/);
});
