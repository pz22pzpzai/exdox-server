import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { hashPassword, signUserToken } from '../shared/auth.js';
import { normalizeBillingCycle, normalizePlanId } from '../shared/billing.js';
import { sendRegistrationConfirmationEmail } from '../shared/confirmationMail.js';
import { activateInvitedUser, buildConfirmationEmailLink, createUser } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

function normalizeOptionalPositiveInteger(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();
    const password = sanitizeText(body.password);
    const fullName = sanitizeText(body.fullName) || null;
    const organisationName = sanitizeText(body.organisationName) || null;
    const inviteToken = sanitizeText(body.inviteToken);
    const billingPlan = normalizePlanId(body.billingPlan);
    const billingCycle = normalizeBillingCycle(body.billingCycle);
    const monthlyDocumentLimit = normalizeOptionalPositiveInteger(body.monthlyDocumentLimit);
    const includedUsers = normalizeOptionalPositiveInteger(body.includedUsers);

    if (!email || !password) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_credentials',
        message: 'Provide email and password to create an account.',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_email',
        message: 'Enter a valid email address.',
      });
    }

    if (password.length < 8) {
      return jsonResponse(400, {
        success: false,
        error: 'weak_password',
        message: 'Use a password with at least 8 characters.',
      });
    }

    const passwordHash = await hashPassword(password);
    if (inviteToken) {
      const user = await activateInvitedUser({
        email,
        passwordHash,
        fullName,
        inviteToken,
      });

      return jsonResponse(201, {
        success: true,
        token: signUserToken(user),
        user,
      });
    }

    const user = await createUser({
      email,
      passwordHash,
      fullName,
      organisationName,
      billingPlan,
      billingCycle,
      monthlyDocumentLimit,
      includedUsers,
    });

    const confirmationToken = user.inviteToken;
    if (!confirmationToken) {
      throw new Error('Confirmation token missing for pending registration.');
    }

    const confirmationLink = buildConfirmationEmailLink(confirmationToken, user.email);
    const organisationLabel = organisationName || `${fullName || 'exdox'} Workspace`;
    const delivery = await sendRegistrationConfirmationEmail({
      toEmail: user.email,
      fullName: user.fullName,
      organisationName: organisationLabel,
      confirmationLink,
    });

    return jsonResponse(201, {
      success: true,
      requiresEmailConfirmation: true,
      message: `We've sent a confirmation email to ${user.email}. Open the link in that message to activate your workspace.`,
      delivery,
      user: {
        id: user.id,
        organisationId: user.organisationId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
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
        : 'register_failed';
    const message = error instanceof Error ? error.message : 'Registration failed.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
