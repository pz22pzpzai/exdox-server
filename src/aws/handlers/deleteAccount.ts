import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { requireAdminUser, requireAuthenticatedUser, verifyPassword } from '../shared/auth.js';
import { isStripeConfigured } from '../shared/billing.js';
import { deleteOrganisationAccount, findUserByEmail, getOrganisationBillingSummary } from '../shared/db.js';
import { awsEnv } from '../shared/env.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';
import { isStripeResourceMissing } from '../shared/stripeSubscription.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const authenticatedUser = requireAuthenticatedUser(event);
    requireAdminUser(authenticatedUser);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const password = sanitizeText(body.password);
    const confirmation = sanitizeText(body.confirmation);

    if (!password || confirmation !== 'DELETE') {
      return jsonResponse(400, {
        success: false,
        error: 'deletion_confirmation_required',
        message: 'Enter your password and type DELETE exactly to confirm workspace deletion.',
      });
    }

    const user = await findUserByEmail(authenticatedUser.email);
    if (
      !user
      || user.id !== authenticatedUser.id
      || user.organisationId !== authenticatedUser.organisationId
      || user.role !== 'Business_Admin'
      || user.invitedByUserId !== null
      || !user.passwordHash
      || !(await verifyPassword(password, user.passwordHash))
    ) {
      return jsonResponse(401, {
        success: false,
        error: 'invalid_credentials',
        message: 'The password is incorrect. Your workspace has not been deleted.',
      });
    }

    const billing = await getOrganisationBillingSummary(authenticatedUser.organisationId);
    if ((billing.stripeCustomerId || billing.stripeSubscriptionId) && (!isStripeConfigured() || !awsEnv.stripeSecretKey)) {
      return jsonResponse(503, {
        success: false,
        error: 'billing_unavailable',
        message: 'Billing cancellation is temporarily unavailable, so no account data was deleted. Please try again shortly.',
      });
    }

    if (awsEnv.stripeSecretKey && (billing.stripeCustomerId || billing.stripeSubscriptionId)) {
      const stripe = new Stripe(awsEnv.stripeSecretKey, { apiVersion: '2026-06-24.dahlia' });
      if (billing.stripeSubscriptionId) {
        try {
          await stripe.subscriptions.cancel(billing.stripeSubscriptionId);
        } catch (error) {
          if (!isStripeResourceMissing(error)) {
            throw error;
          }
        }
      }
      if (billing.stripeCustomerId) {
        try {
          await stripe.customers.del(billing.stripeCustomerId);
        } catch (error) {
          if (!isStripeResourceMissing(error)) {
            throw error;
          }
        }
      }
    }

    await deleteOrganisationAccount(authenticatedUser.organisationId);

    return jsonResponse(200, {
      success: true,
      message: 'Your Exdox workspace, subscription, and account have been deleted.',
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'account_deletion_failed';
    console.error('Account deletion failed.', {
      code,
      message: error instanceof Error ? error.message : 'Unknown account deletion error',
    });
    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message: 'We could not complete account deletion. No further deletion steps will be attempted until you try again.',
    });
  }
}
