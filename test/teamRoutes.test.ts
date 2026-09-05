import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');

test('team routes use explicit handlers instead of runtime method inspection', () => {
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.listHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.createDepartmentHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/team\.assignDepartmentHandler/);
  assert.doesNotMatch(template, /Handler: dist\/aws\/handlers\/team\.handler/);
});
