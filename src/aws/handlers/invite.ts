import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { canInviteUser, getPlanLimitMessage, isBillingActive } from '../shared/billing.js';
import { createInvite, getOrganisationBillingSummary, isOrganisationOwner, listDepartments } from '../shared/db.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';
import { sendInviteEmailWithRetry } from '../shared/inviteMail.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const billing = await getOrganisationBillingSummary(user.organisationId);

    if (!isBillingActive(billing)) {
      return jsonResponse(402, {
        success: false,
        error: 'billing_inactive',
        message: 'This workspace needs an active plan before you can invite teammates.',
      });
    }

    if (!canInviteUser(billing)) {
      return jsonResponse(402, {
        success: false,
        error: 'plan_user_limit_reached',
        message: getPlanLimitMessage(billing, 'users'),
      });
    }

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();
    const fullName = sanitizeText(body.fullName) || null;
    const role = body.role === 'Business_Admin' ? 'Business_Admin' : 'Standard_Employee';
    const departmentId = body.departmentId === null || body.departmentId === undefined || body.departmentId === ''
      ? null
      : Number(body.departmentId);

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

    if (role === 'Business_Admin' && !(await isOrganisationOwner(user))) {
      return jsonResponse(403, {
        success: false,
        error: 'owner_required',
        message: 'Only the workspace owner can invite another business admin.',
      });
    }

    if (departmentId !== null && (!Number.isInteger(departmentId) || departmentId <= 0)) {
      return jsonResponse(400, { success: false, error: 'invalid_department', message: 'Choose a valid department.' });
    }
    if (departmentId !== null) {
      const departments = await listDepartments(user);
      if (!departments.some((department) => department.id === departmentId)) {
        return jsonResponse(400, { success: false, error: 'invalid_department', message: 'Choose a department in this workspace.' });
      }
    }

    const invite = await createInvite({
      organisationId: user.organisationId,
      invitedByUserId: user.id,
      email,
      fullName,
      role,
      departmentId,
    });

    let delivery: { delivered: boolean; method: string } = {
      delivered: false,
      method: 'manual_link_only',
    };

    try {
      delivery = await sendInviteEmailWithRetry({
        toEmail: email,
        inviterName: user.fullName || user.email,
        organisationName: invite.organisationName,
        inviteLink: invite.inviteLink,
      });
    } catch (error) {
      console.warn('Invite email delivery failed after invite creation.', {
        organisationId: user.organisationId,
        invitedEmail: email,
        message: error instanceof Error ? error.message : 'unknown delivery failure',
      });
    }

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
