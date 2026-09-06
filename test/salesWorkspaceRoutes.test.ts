import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const template = readFileSync(new URL('../infra/template.yaml', import.meta.url), 'utf8');

test('sales workspace uses explicit REST handlers', () => {
  assert.match(template, /Handler: dist\/aws\/handlers\/salesWorkspace\.listHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/salesWorkspace\.actionHandler/);
  assert.match(template, /Handler: dist\/aws\/handlers\/salesWorkspace\.deleteHandler/);
  assert.doesNotMatch(template, /Handler: dist\/aws\/handlers\/salesWorkspace\.handler/);
});

test('sales email ingestion has a dedicated token route', () => {
  assert.match(template, /Handler: dist\/aws\/handlers\/salesInbound\.handler/);
  assert.match(template, /Path: \/sales-inbound\/\{token\}\s+Method: POST/);
});

test('commerce imports and auto-publishing were not added', () => {
  const salesPaths = [...template.matchAll(/Path:\s+(\/sales[^\s]*)/g)].map((match) => match[1]);

  assert.equal(salesPaths.some((path) => /shopify|amazon|ebay|auto.?publish/i.test(path)), false);
});
