import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { signUserToken, verifyPassword } from '../shared/auth.js';
import { buildSignupCheckoutReturnUrl, createSelfServeCheckoutSession } from '../shared/billingCheckout.js';
import { findUserByEmail, getOrganisationBillingSummary } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';
import { reconcileStripeSubscription } from '../shared/stripeSubscription.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email);
    const password = sanitizeText(body.password);

    if (!email || !password) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_credentials',
        message: 'Provide both email and password.',
      });
    }

    const user = await findUserByEmail(email);
    if (!user) {
      return jsonResponse(401, {
        success: false,
        error: 'invalid_credentials',
        message: 'Incorrect email or password.',
      });
    }

    if (!user.passwordHash) {
      return jsonResponse(403, {
        success: false,
        error: 'invite_pending',
        message: 'This account has not completed its invite setup yet.',
      });
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      return jsonResponse(401, {
        success: false,
        error: 'invalid_credentials',
        message: 'Incorrect email or password.',
      });
    }

    let billing = await getOrganisationBillingSummary(user.organisationId);
    try {
      billing = await reconcileStripeSubscription(user.organisationId, billing);
    } catch (error) {
      console.warn('Could not reconcile Stripe billing during login.', {
        email: user.email,
        message: error instanceof Error ? error.message : 'Unknown Stripe reconciliation error',
      });
    }

    if (user.status === 'pending_confirmation') {
      const authUser = {
        id: user.id,
        organisationId: user.organisationId,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        status: user.status,
      };
      let checkoutUrl: string | null = null;

      if (billing.status === 'inactive') {
        try {
          const checkout = await createSelfServeCheckoutSession({
            user: authUser,
            planId: billing.planId,
            billingCycle: billing.billingCycle,
            successUrl: buildSignupCheckoutReturnUrl(user.email, 'success'),
            cancelUrl: buildSignupCheckoutReturnUrl(user.email, 'cancelled'),
          });
          checkoutUrl = checkout.checkoutUrl;
        } catch (error) {
          console.warn('Could not resume pending registration checkout.', {
            email: user.email,
            message: error instanceof Error ? error.message : 'Unknown checkout error',
          });
        }
      }

      return jsonResponse(200, {
        success: true,
        requiresEmailConfirmation: true,
        checkoutUrl,
        message: checkoutUrl
          ? 'Continue to secure card setup. Your workspace will remain locked until you confirm your email.'
          : 'Card setup is complete or temporarily unavailable. Confirm your email address from the latest Exdox message before entering the workspace.',
        user: authUser,
      });
    }

    if (user.status !== 'active') {
      return jsonResponse(403, {
        success: false,
        error: 'invite_pending',
        message: 'This account has not completed its invite setup yet.',
      });
    }

    const authUser = {
      id: user.id,
      organisationId: user.organisationId,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      status: user.status,
    };

    return jsonResponse(200, {
      success: true,
      token: signUserToken(authUser),
      user: authUser,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Login failed.';
    return jsonResponse(500, {
      success: false,
      error: 'login_failed',
      message,
    });
  }
}
