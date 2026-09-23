import assert from 'node:assert/strict';
import test from 'node:test';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

process.env.RECEIPT_BUCKET_NAME ||= 'registration-security-test';
process.env.OPENAI_API_KEY ||= 'registration-security-test';
process.env.JWT_SECRET ||= 'registration-security-test';

const { meetsPasswordRequirements } = await import('../src/aws/shared/passwordPolicy.js');
const { requireAuthenticatedUser, signUserToken } = await import('../src/aws/shared/auth.js');
const { handler: register } = await import('../src/aws/handlers/register.js');
const { handler: resetPassword } = await import('../src/aws/handlers/resetPassword.js');

function registrationEvent(input: Record<string, unknown>) {
  return { body: JSON.stringify(input) } as APIGatewayProxyEventV2;
}

test('new passwords need length, a capital letter and punctuation or a symbol', () => {
  for (const password of ['Short1!', 'longlowercase!', 'Longpassword1', 'Long password1']) {
    assert.equal(meetsPasswordRequirements(password), false, password);
  }
  for (const password of ['Longpass!', 'Longpass#', 'Longpass£']) {
    assert.equal(meetsPasswordRequirements(password), true, password);
  }
});

test('registration rejects missing or mismatched confirmation email before creating an account', async () => {
  const base = { email: 'person@example.com', password: 'Longpass!', confirmPassword: 'Longpass!' };
  const missing = await register(registrationEvent(base));
  assert.equal(missing.statusCode, 400);
  assert.equal(JSON.parse(missing.body).error, 'missing_credentials');

  const mismatch = await register(registrationEvent({ ...base, confirmEmail: 'other@example.com' }));
  assert.equal(mismatch.statusCode, 400);
  assert.equal(JSON.parse(mismatch.body).error, 'email_mismatch');
});

test('registration and reset reject a password missing the new requirements', async () => {
  const registration = await register(registrationEvent({
    email: 'person@example.com', confirmEmail: 'person@example.com',
    password: 'longpass!', confirmPassword: 'longpass!',
  }));
  assert.equal(registration.statusCode, 400);
  assert.equal(JSON.parse(registration.body).error, 'weak_password');

  const reset = await resetPassword(registrationEvent({
    email: 'person@example.com', token: 'unused-token', password: 'Longpassword1',
  }));
  assert.equal(reset.statusCode, 400);
  assert.equal(JSON.parse(reset.body).error, 'weak_password');
});

test('a previously issued unconfirmed employee session cannot access APIs', () => {
  const employee = {
    id: 1, organisationId: 2, email: 'employee@example.com', fullName: 'Employee',
    role: 'Standard_Employee' as const, status: 'pending_confirmation' as const,
    emailConfirmationDueAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const employeeToken = signUserToken(employee);
  const event = { headers: { authorization: `Bearer ${employeeToken}` } } as APIGatewayProxyEventV2;
  assert.throws(() => requireAuthenticatedUser(event), /confirm your email address/i);

  const ownerToken = signUserToken({ ...employee, role: 'Business_Admin' as const });
  const ownerEvent = { headers: { authorization: `Bearer ${ownerToken}` } } as APIGatewayProxyEventV2;
  assert.equal(requireAuthenticatedUser(ownerEvent).role, 'Business_Admin');
});
