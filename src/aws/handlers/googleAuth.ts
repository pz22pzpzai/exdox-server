import { randomBytes, createHash } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { OAuth2Client } from 'google-auth-library';

import { hashPassword, signUserToken } from '../shared/auth.js';
import { isBillingActive } from '../shared/billing.js';
import { confirmRegisteredUserEmail, createUser, findUserByEmail, findUserById, getOrganisationBillingSummary, isOrganisationOwner } from '../shared/db.js';
import { sendNewWorkspaceSignupNotificationWithRetry } from '../shared/freeTrialNotification.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';
import { getReceiptJsonObject, putReceiptJsonObjectIfAbsent } from '../shared/s3.js';
import { reconcileStripeSubscription } from '../shared/stripeSubscription.js';
import { hasTwoFactor, readTwoFactor, sendEmailCode, verifyTwoFactor } from '../shared/twoFactor.js';
import { workspaceCountry } from '../shared/workspaceCountry.js';

type GoogleBinding = { sub: string; email: string; userId: number; organisationId: number };
const client = new OAuth2Client();

function bindingKey(sub: string) {
  return `security/google-identities/${createHash('sha256').update(sub).digest('hex')}.json`;
}

function userBindingKey(organisationId: number, userId: number) {
  return `security/google-users/org-${organisationId}/user-${userId}.json`;
}

async function readBinding(sub: string): Promise<GoogleBinding | null> {
  try {
    return await getReceiptJsonObject<GoogleBinding>(bindingKey(sub));
  } catch (error) {
    const status = typeof error === 'object' && error !== null && '$metadata' in error
      ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode)
      : 0;
    if (status === 404 || (error instanceof Error && error.name === 'NoSuchKey')) return null;
    throw error;
  }
}

async function bindGoogleAccount(binding: GoogleBinding) {
  const userKey = userBindingKey(binding.organisationId, binding.userId);
  try {
    await putReceiptJsonObjectIfAbsent(userKey, { sub: binding.sub });
  } catch (error) {
    const existing = await getReceiptJsonObject<{ sub: string }>(userKey);
    if (existing.sub !== binding.sub) {
      const conflict = new Error('This Exdox account is already connected to a different Google account.') as Error & { statusCode: number };
      conflict.statusCode = 409;
      throw conflict;
    }
  }
  try {
    await putReceiptJsonObjectIfAbsent(bindingKey(binding.sub), binding);
  } catch (error) {
    const existing = await readBinding(binding.sub);
    if (existing?.userId === binding.userId && existing.organisationId === binding.organisationId) return;
    throw error;
  }
}

export async function handler(event: APIGatewayProxyEventV2 & { httpMethod?: string }) {
  try {
    const clientId = process.env.GOOGLE_WEB_CLIENT_ID?.trim();
    if ((event.requestContext?.http?.method ?? event.httpMethod) === 'GET') {
      return jsonResponse(200, { success: true, clientId: clientId || null });
    }
    if (!clientId) return jsonResponse(503, { success: false, error: 'google_unavailable', message: 'Google sign-in is not configured yet.' });

    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const idToken = sanitizeText(body.idToken);
    if (!idToken || idToken.length > 8192) return jsonResponse(400, { success: false, error: 'invalid_google_token', message: 'Choose your Google account again.' });

    const ticket = await client.verifyIdToken({ idToken, audience: clientId });
    const claims = ticket.getPayload();
    if (!claims?.sub || !claims.email || claims.email_verified !== true) {
      return jsonResponse(401, { success: false, error: 'invalid_google_identity', message: 'Google did not provide a verified email address.' });
    }
    const email = claims.email.trim().toLowerCase();
    const binding = await readBinding(claims.sub);
    const mode = sanitizeText(body.mode) || 'login';

    if (mode !== 'login' && mode !== 'register') {
      return jsonResponse(400, { success: false, error: 'invalid_mode', message: 'Choose sign in or start a free trial.' });
    }

    let user = binding ? await findUserById(binding.organisationId, binding.userId) : null;
    if (binding && (!user || user.email !== binding.email)) {
      return jsonResponse(403, { success: false, error: 'google_link_changed', message: 'This account needs help reconnecting Google sign-in. Contact Exdox support.' });
    }
    if (!binding) {
      const existingEmail = await findUserByEmail(email);
      if (existingEmail) {
        return jsonResponse(409, {
          success: false,
          error: 'google_link_required',
          message: 'An Exdox account already uses this email. Sign in with your existing method, or choose a different Google address for a new trial.',
        });
      }
      if (mode !== 'register') {
        return jsonResponse(404, { success: false, error: 'google_account_not_found', message: 'No Exdox account is connected to this Google account. Choose Start 14-day free trial.' });
      }
      if (body.termsAccepted !== true) {
        return jsonResponse(400, { success: false, error: 'terms_required', message: 'Accept the Exdox Terms and Conditions to start the free trial.' });
      }
      const accountType = sanitizeText(body.accountType);
      if (accountType !== 'owner' && accountType !== 'sole_trader') {
        return jsonResponse(400, { success: false, error: 'account_type_required', message: 'Choose Business or Sole trader.' });
      }
      const country = workspaceCountry(body.country);
      if (body.country != null && country !== body.country) {
        return jsonResponse(400, { success: false, error: 'invalid_country', message: 'Choose a supported country.' });
      }
      const fullName = sanitizeText(claims.name) || null;
      const organisationName = sanitizeText(body.organisationName)
        || (accountType === 'sole_trader' ? `${fullName || email.split('@')[0]} Workspace` : '');
      if (!organisationName) {
        return jsonResponse(400, { success: false, error: 'missing_organisation_name', message: 'Enter your business name.' });
      }
      user = await createUser({
        email,
        passwordHash: await hashPassword(randomBytes(48).toString('base64url')),
        fullName,
        organisationName,
        country,
        billingPlan: 'trial',
        billingCycle: 'monthly',
        monthlyDocumentLimit: null,
        includedUsers: null,
        startPlanFreeTrial: true,
      });
      if (!user.inviteToken) throw new Error('Google signup did not create a confirmation token.');
      await confirmRegisteredUserEmail({ email, confirmationToken: user.inviteToken });
      await bindGoogleAccount({ sub: claims.sub, email, userId: user.id, organisationId: user.organisationId });
      try {
        await sendNewWorkspaceSignupNotificationWithRetry({
          organisationId: user.organisationId,
          organisationName,
          ownerName: user.fullName,
          ownerEmail: user.email,
          planId: 'trial',
          includedUsers: 'Trial',
          monthlyDocuments: 'Trial',
          source: 'registration',
        });
      } catch (error) {
        console.warn('Could not send internal Google signup notification.', { message: error instanceof Error ? error.message : 'Unknown email error' });
      }
      user = await findUserByEmail(email);
    }
    if (!user || user.removedAt || user.status !== 'active') {
      return jsonResponse(403, { success: false, error: 'account_unavailable', message: 'This Exdox account is not active.' });
    }

    const twoFactor = await readTwoFactor(user.id);
    if (hasTwoFactor(twoFactor)) {
      const code = sanitizeText(body.twoFactorCode);
      const method = body.twoFactorMethod;
      if (!code) {
        if (twoFactor.emailEnabled) await sendEmailCode(user.id, user.email, 'login');
        return jsonResponse(200, { success: true, requiresTwoFactor: true, emailEnabled: twoFactor.emailEnabled, authenticatorEnabled: Boolean(twoFactor.totpSecret), message: 'Enter your Exdox verification code to complete Google sign-in.' });
      }
      if ((method !== 'email' && method !== 'authenticator' && method !== 'recovery') || !await verifyTwoFactor(user.id, code, method)) {
        return jsonResponse(401, { success: false, error: 'invalid_two_factor_code', message: 'The verification code is incorrect or expired.' });
      }
    }

    let billing = await getOrganisationBillingSummary(user.organisationId);
    try {
      billing = await reconcileStripeSubscription(user.organisationId, billing);
    } catch (error) {
      console.warn('Could not reconcile Stripe billing during Google sign-in.', { message: error instanceof Error ? error.message : 'Unknown Stripe error' });
    }
    const authUser = {
      id: user.id, organisationId: user.organisationId, email: user.email, fullName: user.fullName,
      role: user.role, status: user.status, trialEndsAt: billing.planId === 'trial' ? billing.trialEndsAt : null,
    };
    const isOwner = await isOrganisationOwner(authUser);
    if (!isBillingActive(billing) && !(isOwner && billing.planId === 'trial')) {
      return jsonResponse(402, { success: false, error: 'billing_inactive', message: 'The workspace trial or subscription has ended. Ask the owner to choose a plan in Billing.' });
    }
    return jsonResponse(200, { success: true, token: signUserToken(authUser), user: { ...authUser, isOwner }, trialEndsAt: authUser.trialEndsAt });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Google sign-in failed.';
    const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
    if (message.includes('Token used too late') || message.includes('Wrong recipient') || message.includes('Invalid token signature') || message.includes('No pem found')) {
      return jsonResponse(401, { success: false, error: 'invalid_google_token', message: 'Google sign-in expired or could not be verified. Choose your account again.' });
    }
    if (code === 'duplicate_user') return jsonResponse(409, { success: false, error: 'google_account_exists', message: 'This email already has an Exdox account. Sign in with your existing method, or choose a different Google address for a new trial.' });
    if (typeof error === 'object' && error !== null && 'statusCode' in error && error.statusCode === 409) {
      return jsonResponse(409, { success: false, error: 'google_already_linked', message });
    }
    console.error('Google authentication failed.', { message });
    return jsonResponse(500, { success: false, error: 'google_auth_failed', message: 'Google sign-in is temporarily unavailable. Please try again.' });
  }
}
