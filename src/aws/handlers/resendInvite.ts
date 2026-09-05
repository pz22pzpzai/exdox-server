import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { getPendingInviteForResend, isOrganisationOwner } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sendInviteEmailWithRetry } from '../shared/inviteMail.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const userId = Number(body.userId);
    if (!Number.isInteger(userId) || userId <= 0) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_invite_user',
        message: 'Choose a pending invitation to resend.',
      });
    }

    const invite = await getPendingInviteForResend(user, userId);
    if (!invite) {
      return jsonResponse(404, {
        success: false,
        error: 'pending_invite_not_found',
        message: 'This invitation is no longer pending or could not be found.',
      });
    }
    if (invite.invitedUser.role === 'Business_Admin' && !(await isOrganisationOwner(user))) {
      return jsonResponse(403, {
        success: false,
        error: 'owner_required',
        message: 'Only the workspace owner can resend a business admin invitation.',
      });
    }

    const delivery = await sendInviteEmailWithRetry({
      toEmail: invite.invitedUser.email,
      inviterName: user.fullName || user.email,
      organisationName: invite.organisationName,
      inviteLink: invite.inviteLink,
    });
    if (!delivery.delivered) {
      return jsonResponse(503, {
        success: false,
        error: 'invite_email_not_configured',
        message: 'Invitation email delivery is not configured. Use the existing invite link instead.',
      });
    }
    return jsonResponse(200, {
      success: true,
      invite: {
        userId: invite.invitedUser.id,
        email: invite.invitedUser.email,
        delivery,
      },
    });
  } catch (error) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 502;
    return jsonResponse(statusCode, {
      success: false,
      error: 'invite_resend_failed',
      message: error instanceof Error ? error.message : 'Could not resend the invitation email.',
    });
  }
}
