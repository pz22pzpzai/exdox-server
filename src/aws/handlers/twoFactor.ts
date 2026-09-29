import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { requireAuthenticatedUser, verifyPassword } from '../shared/auth.js';
import { findUserByEmail } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { beginAuthenticator, disableTwoFactor, enableAuthenticator, enableEmail, readTwoFactor, sendEmailCode, twoFactorStatus } from '../shared/twoFactor.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const stored = await findUserByEmail(user.email);
    if (!stored || stored.id !== user.id || stored.status !== 'active' || stored.removedAt) {
      return jsonResponse(401, { success: false, message: 'Sign in again to change security settings.' });
    }
    if ((event.requestContext?.http?.method ?? (event as APIGatewayProxyEventV2 & { httpMethod?: string }).httpMethod ?? 'GET').toUpperCase() === 'GET') {
      return jsonResponse(200, { success: true, ...twoFactorStatus(await readTwoFactor(user.id)) });
    }
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const action = String(body.action ?? '');
    const code = String(body.code ?? '').trim();
    if (action === 'begin_authenticator') {
      if (!stored.passwordHash || !await verifyPassword(String(body.password ?? ''), stored.passwordHash)) {
        return jsonResponse(400, { success: false, message: 'Enter your account password to set up an authenticator.' });
      }
      return jsonResponse(200, { success: true, ...(await beginAuthenticator(user.id, user.email)) });
    }
    if (action === 'enable_authenticator') {
      return jsonResponse(200, { success: true, ...(await enableAuthenticator(user.id, code)) });
    }
    if (action === 'send_email_code') {
      const sent = await sendEmailCode(user.id, user.email, 'setup');
      return jsonResponse(200, { success: true, message: sent ? 'Code sent to your registered email address.' : 'Use the recent code we sent, or wait one minute before requesting another.' });
    }
    if (action === 'enable_email') {
      return jsonResponse(200, { success: true, ...(await enableEmail(user.id, code)) });
    }
    if (action === 'disable') {
      const method = body.method;
      const codeMethod = body.codeMethod;
      if ((method !== 'email' && method !== 'authenticator') || (codeMethod !== 'email' && codeMethod !== 'authenticator' && codeMethod !== 'recovery')) {
        return jsonResponse(400, { success: false, message: 'Choose a valid verification method.' });
      }
      if (!stored.passwordHash || !await verifyPassword(String(body.password ?? ''), stored.passwordHash)) {
        return jsonResponse(400, { success: false, message: 'The password is incorrect.' });
      }
      return jsonResponse(200, { success: true, ...(await disableTwoFactor(user.id, method, code, codeMethod)) });
    }
    return jsonResponse(400, { success: false, message: 'Unknown security action.' });
  } catch (error) {
    return jsonResponse(400, { success: false, message: error instanceof Error ? error.message : 'Could not change two-factor settings.' });
  }
}
