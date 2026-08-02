import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { signPasswordResetToken } from '../shared/auth.js';
import { buildPasswordResetLink, findUserByEmail, getOrganisationName } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';
import { sendPasswordResetEmail } from '../shared/passwordResetMail.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();

    if (!email) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_email',
        message: 'Enter the email address linked to your Exdox account.',
      });
    }

    const genericMessage = 'If that email belongs to an active Exdox account, a password reset link will be sent.';
    const user = await findUserByEmail(email);
    if (!user || user.status !== 'active' || !user.passwordHash) {
      return jsonResponse(200, {
        success: true,
        delivered: false,
        message: genericMessage,
      });
    }

    const organisationName = await getOrganisationName(user.organisationId);
    const resetToken = signPasswordResetToken(user);
    const resetLink = buildPasswordResetLink(resetToken, user.email);

    let delivered = false;
    try {
      const delivery = await sendPasswordResetEmail({
        toEmail: user.email,
        fullName: user.fullName,
        organisationName,
        resetLink,
      });
      delivered = delivery.delivered;
    } catch (error) {
      console.warn('Could not send password reset email.', {
        email: user.email,
        message: error instanceof Error ? error.message : 'Unknown email error',
      });
    }

    return jsonResponse(200, {
      success: true,
      delivered,
      message: genericMessage,
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'request_password_reset_failed';
    const message = error instanceof Error ? error.message : 'Could not start the password reset.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
