import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const database = readFileSync(new URL('../src/aws/shared/db.ts', import.meta.url), 'utf8');

test('S3 billing counts organisation-scoped user pointers instead of downloading every user', () => {
  const billingSummary = database.match(/export async function getOrganisationBillingSummary[\s\S]*?(?=\nexport async function getOrganisationBillingStatus)/)?.[0];
  assert.ok(billingSummary, 'Expected the billing summary function to exist.');
  assert.match(billingSummary, /countS3UsersForOrganisation\(organisationId\)/);
  assert.doesNotMatch(billingSummary, /listS3UsersForOrganisation\(organisationId\)/);
});

test('S3 user reads use an organisation-scoped pointer prefix with a legacy backfill', () => {
  assert.match(database, /organisation-users\/org-\$\{organisationId\}\//);
  assert.match(database, /listS3OrganisationUserKeys\(organisationId\)/);
  assert.match(database, /pointerKeys\.includes\(readyKey\)/);
  assert.match(database, /putReceiptJsonObject\(readyKey/);
  assert.match(database, /listAllReceiptJsonKeys\('users\/'\)/);
  assert.match(database, /Build them once, then all future billing checks avoid downloading every/);
});

test('S3 user writes keep organisation pointers synchronised', () => {
  const putUser = database.match(/async function putS3User[\s\S]*?(?=\nasync function listS3OrganisationUserKeys)/)?.[0];
  assert.ok(putUser, 'Expected the S3 user write helper to exist.');
  assert.match(putUser, /putReceiptJsonObject\(userKey, user\)/);
  assert.match(putUser, /if \(user\.removedAt\)[\s\S]*deleteReceiptObject\(pointerKey\)/);
  assert.match(putUser, /putReceiptJsonObject\(pointerKey/);

  const legacyDirectWrites = database.match(/putReceiptJsonObject\(buildUserKey/g) ?? [];
  assert.equal(legacyDirectWrites.length, 0);
});
