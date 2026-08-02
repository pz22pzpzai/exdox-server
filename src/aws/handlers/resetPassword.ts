import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { hashPassword, verifyPasswordResetToken } from '../shared/auth.js';
import { findUserByEmail, updateUserPassword } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();
    const token = sanitizeText(body.token);
    const password = sanitizeText(body.password);

    if (!email || !token || !password) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_reset_details',
        message: 'Email address, reset link, and new password are all required.',
      });
    }

    if (password.length < 8) {
      return jsonResponse(400, {
        success: false,
        error: 'weak_password',
        message: 'Use a password with at least 8 characters.',
      });
    }

    const resetPayload = verifyPasswordResetToken(token);
    if (resetPayload.email !== email) {
      return jsonResponse(400, {
        success: false,
        error: 'email_mismatch',
        message: 'This reset link does not match the selected email address.',
      });
    }

    const user = await findUserByEmail(email);
    if (!user || user.id !== resetPayload.userId || user.status !== 'active' || !user.passwordHash) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_reset_request',
        message: 'This password reset link is no longer valid.',
      });
    }

    const passwordHash = await hashPassword(password);
    await updateUserPassword({
      email,
      userId: resetPayload.userId,
      passwordHash,
    });

    return jsonResponse(200, {
      success: true,
      message: 'Your password has been updated. You can now log in with the new password.',
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'reset_password_failed';
    const message = error instanceof Error ? error.message : 'Could not reset the password.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
