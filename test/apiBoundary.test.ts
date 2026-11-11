import test from 'node:test';
import assert from 'node:assert/strict';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
process.env.RECEIPT_BUCKET_NAME = 'ci-isolated-bucket';
process.env.OPENAI_API_KEY = 'ci-not-a-real-key';
process.env.JWT_SECRET = 'ci-only-test-secret';
const { handler: health } = await import('../src/aws/handlers/health.js');
const { handler: receipts } = await import('../src/aws/handlers/listReceipts.js');
test('health handler produces the API JSON response contract', async () => {
  const response = await health();
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'application/json');
  assert.equal(JSON.parse(response.body).ok, true);
});
test('receipt handler rejects unauthenticated requests before accessing storage', async () => {
  const response = await receipts({ headers: {}, queryStringParameters: null } as APIGatewayProxyEventV2);
  assert.equal(response.statusCode, 401);
  assert.equal(JSON.parse(response.body).success, false);
});
