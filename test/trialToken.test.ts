import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

process.env.RECEIPT_BUCKET_NAME ||= 'trial-token-test';
process.env.OPENAI_API_KEY ||= 'trial-token-test';
process.env.JWT_SECRET ||= 'trial-token-test';
const { requireAuthenticatedUser, signUserToken } = await import('../src/aws/shared/auth.js');

test('a cached trial token cannot keep using workspace APIs after day 14', () => {
  const user = {
    id: 1,
    organisationId: 2,
    email: 'trial@example.com',
    fullName: 'Trial owner',
    role: 'Business_Admin' as const,
    status: 'active' as const,
    trialEndsAt: new Date(Date.now() - 60_000).toISOString(),
  };
  const token = signUserToken(user);
  const event = { headers: { authorization: `Bearer ${token}` } } as APIGatewayProxyEventV2;
  assert.throws(() => requireAuthenticatedUser(event), /free trial has ended/i);
  const currentToken = signUserToken({ ...user, trialEndsAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(requireAuthenticatedUser({ headers: { authorization: `Bearer ${currentToken}` } } as APIGatewayProxyEventV2).organisationId, 2);
});
