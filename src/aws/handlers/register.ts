import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { hashPassword, signUserToken } from '../shared/auth.js';
import { canInviteUser, getPlanLimitMessage } from '../shared/billing.js';
import { sendRegistrationConfirmationEmailWithRetry } from '../shared/confirmationMail.js';
import {
  activateInvitedUser,
  buildConfirmationEmailLink,
  createDomainEmployeeUser,
  createUser,
  findConfirmedAdminOrganisationForEmailDomain,
  getOrganisationBillingSummary,
} from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';
import { meetsPasswordRequirements, passwordRequirementsMessage } from '../shared/passwordPolicy.js';
import { sendNewWorkspaceSignupNotificationWithRetry } from '../shared/freeTrialNotification.js';
import { workspaceCountry, type WorkspaceCountry } from '../shared/workspaceCountry.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();
    const confirmEmail = sanitizeText(body.confirmEmail).toLowerCase();
    const password = sanitizeText(body.password);
    const confirmPassword = sanitizeText(body.confirmPassword);
    const fullName = sanitizeText(body.fullName) || null;
    const organisationName = sanitizeText(body.organisationName) || null;
    const inviteToken = sanitizeText(body.inviteToken);
    const termsAccepted = body.termsAccepted === true;
    const termsVersion = sanitizeText(body.termsVersion) || '2026-07-26';
    const accountType = body.accountType === 'employee'
      ? 'employee'
      : body.accountType === 'sole_trader'
        ? 'sole_trader'
        : 'owner';
    const country = workspaceCountry(body.country);
    if (body.country != null && country !== body.country) {
      return jsonResponse(400, { success: false, error: 'invalid_country', message: 'Choose a supported country.' });
    }

    if (!email || !confirmEmail || !password || !confirmPassword) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_credentials',
        message: 'Enter your email address twice and your password twice to create an account.',
      });
    }

    if (email !== confirmEmail) {
      return jsonResponse(400, {
        success: false,
        error: 'email_mismatch',
        message: 'The email addresses do not match. Enter the same email address in both fields.',
      });
    }

    if (password !== confirmPassword) {
      return jsonResponse(400, {
        success: false,
        error: 'password_mismatch',
        message: 'The passwords do not match. Enter the same password in both fields.',
      });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_email',
        message: 'Enter a valid email address.',
      });
    }

    if (!meetsPasswordRequirements(password)) {
      return jsonResponse(400, {
        success: false,
        error: 'weak_password',
        message: passwordRequirementsMessage,
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

      const invitedBilling = await getOrganisationBillingSummary(user.organisationId);
      return jsonResponse(201, {
        success: true,
        token: signUserToken({ ...user, trialEndsAt: invitedBilling.status === 'trialing' ? invitedBilling.trialEndsAt : null }),
        user,
      });
    }

    const matchedOrganisation = await findConfirmedAdminOrganisationForEmailDomain(email);
    if (matchedOrganisation) {
      const billing = await getOrganisationBillingSummary(matchedOrganisation.organisationId);
      if (!canInviteUser(billing)) {
        const error = new Error(getPlanLimitMessage(billing, 'users')) as Error & { statusCode?: number; code?: string };
        error.statusCode = 403;
        error.code = 'user_limit_reached';
        throw error;
      }

      const user = await createDomainEmployeeUser({
        organisationId: matchedOrganisation.organisationId,
        email,
        passwordHash,
        fullName,
      });
      let confirmationDelivered = false;
      if (user.inviteToken) {
        try {
          const delivery = await sendRegistrationConfirmationEmailWithRetry({
            toEmail: user.email,
            fullName: user.fullName,
            organisationName: matchedOrganisation.organisationName,
            confirmationLink: buildConfirmationEmailLink(user.inviteToken, user.email),
          });
          confirmationDelivered = delivery.delivered;
        } catch (error) {
          console.warn('Could not send employee confirmation email.', {
            email: user.email,
            message: error instanceof Error ? error.message : 'Unknown email error',
          });
        }
      }

      return jsonResponse(201, {
        success: true,
        requiresEmailConfirmation: true,
        checkoutUrl: null,
        accountType: 'employee',
        message: confirmationDelivered
          ? `You have joined ${matchedOrganisation.organisationName}. Check your email to confirm your address, then sign in to use the Exdox app. No card setup is required.`
          : `You have joined ${matchedOrganisation.organisationName}, but the confirmation email could not be sent. Use resend confirmation or contact contact@exdox.co.uk. No card setup is required.`,
        user: {
          id: user.id,
          organisationId: user.organisationId,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          status: user.status,
        },
      });
    }

    if (accountType === 'employee') {
      return jsonResponse(404, {
        success: false,
        error: 'company_workspace_not_found',
        message: 'We could not find an active Exdox workspace for this company email domain. Ask the business owner to create and confirm the company workspace first.',
      });
    }

    if (accountType === 'owner' && !organisationName) {
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

    const workspaceName = organisationName || `${fullName || email.split('@')[0]} Workspace`;

    const user = await createUser({
      email,
      passwordHash,
      fullName,
      organisationName: workspaceName,
      country,
      billingPlan: 'trial',
      billingCycle: 'monthly',
      monthlyDocumentLimit: null,
      includedUsers: null,
      startPlanFreeTrial: true,
    });

    try {
      await sendNewWorkspaceSignupNotificationWithRetry({
        organisationId: user.organisationId,
        organisationName: workspaceName,
        ownerName: user.fullName,
        ownerEmail: user.email,
        planId: 'trial',
        includedUsers: 'Trial',
        monthlyDocuments: 'Trial',
        source: 'registration',
      });
    } catch (error) {
      console.error('Could not send internal signup notification.', {
        organisationId: user.organisationId,
        message: error instanceof Error ? error.message : 'Unknown email error',
      });
    }

    let confirmationDelivered = false;
    if (user.inviteToken) {
      const confirmationLink = buildConfirmationEmailLink(user.inviteToken, user.email);
      try {
        const delivery = await sendRegistrationConfirmationEmailWithRetry({
          toEmail: user.email,
          fullName: user.fullName,
          organisationName: workspaceName,
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

    return jsonResponse(201, {
      success: true,
      requiresEmailConfirmation: true,
      checkoutUrl: null,
      message: buildRegistrationMessage({
        confirmationDelivered,
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

function buildRegistrationMessage(input: {
  confirmationDelivered: boolean;
  termsVersion: string;
}) {
  const confirmationSummary = input.confirmationDelivered
    ? 'We have sent your confirmation email.'
    : 'We could not send the confirmation email right now; contact contact@exdox.co.uk so we can activate access.';
  return `Your 14-day free trial has started. ${confirmationSummary} You can use the workspace now and have three days to confirm your email. Choose a paid plan only when you are ready to continue after the trial; no payment happens automatically. Terms version ${input.termsVersion} was accepted during registration.`;
}
