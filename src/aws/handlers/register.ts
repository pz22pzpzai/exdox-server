import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { hashPassword, signUserToken } from '../shared/auth.js';
import { normalizeBillingCycle, normalizePlanId, resolveSelfServeSubscriptionSelection } from '../shared/billing.js';
import { buildSignupCheckoutReturnUrl, createSelfServeCheckoutSession } from '../shared/billingCheckout.js';
import { sendRegistrationConfirmationEmail } from '../shared/confirmationMail.js';
import { activateInvitedUser, buildConfirmationEmailLink, createUser } from '../shared/db.js';
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
    const termsAccepted = body.termsAccepted === true;
    const termsVersion = sanitizeText(body.termsVersion) || '2026-07-26';

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

    if (!organisationName) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_organisation_name',
        message: 'Enter your organisation name to create a workspace.',
      });
    }

    if (!termsAccepted) {
      return jsonResponse(400, {
        success: false,
        error: 'terms_required',
        message: 'You must accept the Exdox Terms and Conditions before starting a free trial.',
      });
    }

    const billingSelection = resolveSelfServeSubscriptionSelection({
      planId: normalizePlanId(body.billingPlan),
      monthlyDocumentLimit: typeof body.monthlyDocumentLimit === 'number' ? body.monthlyDocumentLimit : null,
      includedUsers: typeof body.includedUsers === 'number' ? body.includedUsers : null,
    });

    const user = await createUser({
      email,
      passwordHash,
      fullName,
      organisationName,
      billingPlan: billingSelection.planId,
      billingCycle: normalizeBillingCycle(body.billingCycle),
      monthlyDocumentLimit: billingSelection.monthlyDocumentLimit,
      includedUsers: billingSelection.includedUsers,
    });

    let confirmationDelivered = false;
    if (user.inviteToken) {
      const confirmationLink = buildConfirmationEmailLink(user.inviteToken, user.email);
      try {
        const delivery = await sendRegistrationConfirmationEmail({
          toEmail: user.email,
          fullName: user.fullName,
          organisationName,
          confirmationLink,
        });
        confirmationDelivered = delivery.delivered;
      } catch (error) {
        console.warn('Could not send registration confirmation email.', {
          email: user.email,
          message: error instanceof Error ? error.message : 'Unknown email error',
        });
      }
    }

    let checkoutUrl: string | null = null;
    try {
      const successUrl = buildSignupCheckoutReturnUrl(user.email, 'success');
      const cancelUrl = buildSignupCheckoutReturnUrl(user.email, 'cancelled');
      const checkout = await createSelfServeCheckoutSession({
        user,
        planId: billingSelection.planId,
        billingCycle: normalizeBillingCycle(body.billingCycle),
        successUrl,
        cancelUrl,
      });
      checkoutUrl = checkout.checkoutUrl;
    } catch (error) {
      console.warn('Could not start registration checkout.', {
        email: user.email,
        message: error instanceof Error ? error.message : 'Unknown checkout error',
      });
    }

    return jsonResponse(201, {
      success: true,
      requiresEmailConfirmation: true,
      checkoutUrl,
      message: buildRegistrationMessage({
        confirmationDelivered,
        checkoutReady: Boolean(checkoutUrl),
        packageLabel: billingSelection.label,
        monthlyAmountPence: billingSelection.monthlyAmountPence,
        termsVersion,
      }),
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

function formatGbp(amountPence: number) {
  return new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: 'GBP',
  }).format(amountPence / 100);
}

function buildRegistrationMessage(input: {
  confirmationDelivered: boolean;
  checkoutReady: boolean;
  packageLabel: string;
  monthlyAmountPence: number;
  termsVersion: string;
}) {
  const packageSummary = `${input.packageLabel} package (${formatGbp(input.monthlyAmountPence)} per month, VAT included)`;
  const confirmationSummary = input.confirmationDelivered
    ? 'We have sent your confirmation email.'
    : 'We could not send the confirmation email right now; contact contact@exdox.co.uk so we can activate access.';
  const checkoutSummary = input.checkoutReady
    ? 'Continue to secure card setup now.'
    : 'Secure card setup is temporarily unavailable; confirm your email and log in to try again.';
  return `${checkoutSummary} ${confirmationSummary} Your ${packageSummary} is reserved. Workspace access stays locked until email confirmation. Terms version ${input.termsVersion} was accepted during registration.`;
}
