import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { hashPassword, signUserToken } from '../shared/auth.js';
import { normalizeBillingCycle, normalizePlanId } from '../shared/billing.js';
import { activateInvitedUser, createUser } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

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
    const user = inviteToken
      ? await activateInvitedUser({
          email,
          passwordHash,
          fullName,
          inviteToken,
        })
      : await createUser({
          email,
          passwordHash,
          fullName,
          organisationName,
          billingPlan,
          billingCycle,
        });

    return jsonResponse(201, {
      success: true,
      token: signUserToken(user),
      user,
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
