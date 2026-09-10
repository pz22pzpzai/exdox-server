import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');
const teamHandler = readFileSync(new URL('../src/aws/handlers/team.ts', import.meta.url), 'utf8');
const database = readFileSync(new URL('../src/aws/shared/db.ts', import.meta.url), 'utf8');

test('team routes use explicit handlers instead of runtime method inspection', () => {
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.listHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.createDepartmentHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.assignDepartmentHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.removeMemberHandler/);
  assert.doesNotMatch(template, /Handler: dist\/aws\/handlers\/team\.handler/);
});

test('team member removal has a dedicated admin API route', () => {
  assert.match(template, /Path: \/team\/\{userId\}\s+Method: DELETE/);
  assert.match(teamHandler, /removeMemberHandler[\s\S]*requireAdminUser\(user\)[\s\S]*removeTeamMember\(user, userId\)/);
  assert.match(database, /You cannot remove the account you are currently signed in with/);
  assert.match(database, /The workspace owner cannot be removed from Team members/);
  assert.match(database, /password_hash = NULL[\s\S]*removed_at = UTC_TIMESTAMP\(\)/);
});

test('pending invitations have a dedicated resend route', () => {
  assert.match(template, /Handler: dist\/aws\/handlers\/resendInvite\.handler/);
  assert.match(template, /Path: \/invite\/resend\s+Method: POST/);
});
