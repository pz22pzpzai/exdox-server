import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { signUserToken, verifyPassword } from '../shared/auth.js';
import { findUserByEmail } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email);
    const password = sanitizeText(body.password);

    if (!email || !password) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_credentials',
        message: 'Provide both email and password.',
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return jsonResponse(401, {
        success: false,
        error: 'invalid_credentials',
        message: 'Incorrect email or password.',
      });
    }

    if (!user.passwordHash) {
      return jsonResponse(403, {
        success: false,
        error: 'invite_pending',
        message: 'This account has not completed its invite setup yet.',
      });
    }

    if (user.status === 'pending_confirmation') {
      return jsonResponse(403, {
        success: false,
        error: 'email_confirmation_required',
        message: 'Confirm your email address from the message we sent before signing in.',
      });
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return jsonResponse(401, {
        success: false,
        error: 'invalid_credentials',
        message: 'Incorrect email or password.',
      });
    }

    if (user.status !== 'active') {
      return jsonResponse(403, {
        success: false,
        error: 'invite_pending',
        message: 'This account has not completed its invite setup yet.',
      });
    }

    const authUser = {
      id: user.id,
      organisationId: user.organisationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
    };

    return jsonResponse(200, {
      success: true,
      token: signUserToken(authUser),
      user: authUser,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Login failed.';
    return jsonResponse(500, {
      success: false,
      error: 'login_failed',
      message,
    });
  }
}
