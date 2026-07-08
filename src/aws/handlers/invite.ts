import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createInvite } from '../shared/db.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';
import { sendInviteEmail } from '../shared/inviteMail.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();
    const fullName = sanitizeText(body.fullName) || null;

    if (!email) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_email',
        message: 'Provide the employee email address to send an invite.',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_email',
        message: 'Enter a valid email address.',
      });
    }

    const invite = await createInvite({
      organisationId: user.organisationId,
      invitedByUserId: user.id,
      email,
      fullName,
      role: 'Standard_Employee',
    });

    const delivery = await sendInviteEmail({
      toEmail: email,
      inviterName: user.fullName || user.email,
      organisationName: invite.organisationName,
      inviteLink: invite.inviteLink,
    });

    return jsonResponse(201, {
      success: true,
      invite: {
        userId: invite.invitedUser.id,
        email: invite.invitedUser.email,
        fullName: invite.invitedUser.fullName,
        role: invite.invitedUser.role,
        status: invite.invitedUser.status,
        organisationId: invite.invitedUser.organisationId,
        inviteLink: invite.inviteLink,
        delivery,
      },
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'invite_failed';
    const message = error instanceof Error ? error.message : 'Invite failed.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
