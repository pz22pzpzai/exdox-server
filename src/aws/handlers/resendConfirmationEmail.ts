import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { sendRegistrationConfirmationEmail } from '../shared/confirmationMail.js';
import {
  buildConfirmationEmailLink,
  findUserByEmail,
  getOrganisationName,
  rotateRegistrationConfirmationToken,
} from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();

    if (!email) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_email',
        message: 'Enter the email address that needs a confirmation link.',
      });
    }

    const user = await findUserByEmail(email);
    if (!user || user.status !== 'pending_confirmation' || !user.inviteToken) {
      return jsonResponse(200, {
        success: true,
        message: 'If this email still needs confirmation, a fresh confirmation link will be sent.',
      });
    }

    const refreshedUser = await rotateRegistrationConfirmationToken(user.email);
    if (!refreshedUser?.inviteToken) {
      return jsonResponse(200, {
        success: true,
        message: 'If this email still needs confirmation, a fresh confirmation link will be sent.',
      });
    }

    const organisationName = await getOrganisationName(refreshedUser.organisationId);
    const confirmationLink = buildConfirmationEmailLink(refreshedUser.inviteToken, refreshedUser.email);

    let delivered = false;
    try {
      const delivery = await sendRegistrationConfirmationEmail({
        toEmail: refreshedUser.email,
        fullName: refreshedUser.fullName,
        organisationName,
        confirmationLink,
      });
      delivered = delivery.delivered;
    } catch (error) {
      console.warn('Could not resend registration confirmation email.', {
        email: refreshedUser.email,
        message: error instanceof Error ? error.message : 'Unknown email error',
      });
    }

    return jsonResponse(200, {
      success: true,
      delivered,
      message: delivered
        ? `A fresh confirmation email has been sent to ${refreshedUser.email}. All earlier confirmation links are now invalid.`
        : 'We could not send the confirmation email right now. Contact contact@exdox.co.uk and we will help you activate the workspace.',
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'resend_confirmation_failed';
    const message = error instanceof Error ? error.message : 'Could not resend the confirmation email.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
