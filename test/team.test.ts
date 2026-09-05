import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveRequestMethod } from '../src/aws/shared/requestMethod.js';

test('team request method supports REST API events', () => {
  assert.equal(resolveRequestMethod({ httpMethod: 'PUT' }), 'PUT');
});

test('team request method supports HTTP API v2 events', () => {
  assert.equal(resolveRequestMethod({ requestContext: { http: { method: 'get' } } }), 'GET');
});

test('team request method prefers the HTTP API v2 value when both are present', () => {
  assert.equal(
    resolveRequestMethod({ requestContext: { http: { method: 'POST' } }, httpMethod: 'GET' }),
    'POST',
  );
});
