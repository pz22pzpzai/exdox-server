import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

process.env.RECEIPT_BUCKET_NAME ||= 'platform-admin-test';
process.env.OPENAI_API_KEY ||= 'platform-admin-test';
process.env.JWT_SECRET ||= 'platform-admin-test';

const { signUserToken } = await import('../src/aws/shared/auth.js');
const { handler } = await import('../src/aws/handlers/platformAdmin.js');

test('platform account list rejects other users and a non-admin Terry session', async () => {
  const base = { id: 11, organisationId: 7, fullName: 'Test User', role: 'Business_Admin' as const, status: 'active' as const };
  for (const user of [
    { ...base, email: 'another@example.com' },
    { ...base, email: 'terryreedbfv@outlook.com', role: 'Standard_Employee' as const },
    { ...base, email: 'terryreedbfv@outlook.com', status: 'pending_invite' as const },
  ]) {
    const token = signUserToken(user);
    const event = { headers: { authorization: `Bearer ${token}` } } as APIGatewayProxyEventV2;
    const response = await handler(event);
    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(JSON.parse(response.body).workspaces, undefined);
  }
});
