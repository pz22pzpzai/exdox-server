import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { getPlanDefinition, isStripeConfigured, normalizeBillingCycle, normalizePlanId, resolveSelfServeSubscriptionSelection } from '../shared/billing.js';
import { awsEnv } from '../shared/env.js';
import { getOrganisationBillingSummary, getOrganisationName, updateOrganisationBillingProfile } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);

    if (!isStripeConfigured() || !awsEnv.stripeSecretKey) {
      return jsonResponse(503, {
        success: false,
        error: 'billing_not_configured',
        message: 'Online checkout is not available for this workspace yet. Contact contact@exdox.co.uk to change plans.',
      });
    }

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const planId = normalizePlanId(body.planId);
    const billingCycle = normalizeBillingCycle(body.billingCycle);
    const stripe = new Stripe(awsEnv.stripeSecretKey, {
      apiVersion: '2026-06-24.dahlia',
    });

    const billing = await getOrganisationBillingSummary(user.organisationId);
    if (billing.stripeSubscriptionId && billing.status !== 'inactive' && billing.status !== 'canceled') {
      return jsonResponse(409, {
        success: false,
        error: 'subscription_already_exists',
        message: 'This workspace already has an active or trial subscription. Use the billing portal to manage or cancel it.',
      });
    }

    if (billing.status === 'inactive' && planId !== billing.planId) {
      return jsonResponse(400, {
        success: false,
        error: 'checkout_selection_mismatch',
        message: 'Start checkout for the plan selected during registration, or return to Pricing to choose a different package before registering.',
      });
    }

    const selection = resolveSelfServeSubscriptionSelection({
      planId: billing.status === 'inactive' ? billing.planId : planId,
      monthlyDocumentLimit: billing.status === 'inactive' ? billing.monthlyDocumentLimit : getPlanDefinition(planId).monthlyDocumentLimit,
      includedUsers: billing.status === 'inactive' ? billing.includedUsers : getPlanDefinition(planId).includedUsers,
    });

    const organisationName = await getOrganisationName(user.organisationId);
    let customerId = billing.stripeCustomerId;
    const planDefinition = getPlanDefinition(selection.planId);

    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        name: organisationName,
        metadata: {
          organisationId: String(user.organisationId),
          planId,
        },
      });
      customerId = customer.id;
      await updateOrganisationBillingProfile({
        organisationId: user.organisationId,
        stripeCustomerId: customerId,
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      success_url: awsEnv.stripeCheckoutSuccessUrl,
      cancel_url: awsEnv.stripeCheckoutCancelUrl,
      payment_method_collection: 'always',
      consent_collection: {
        terms_of_service: 'required',
      },
      line_items: [{
        price_data: {
          currency: 'gbp',
          product_data: {
            name: `Exdox ${selection.label}`,
            metadata: {
              planId: selection.planId,
              includedUsers: String(selection.includedUsers),
              monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
            },
          },
          unit_amount: selection.monthlyAmountPence,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      }],
      metadata: {
        organisationId: String(user.organisationId),
        planId: selection.planId,
        billingCycle,
        includedUsers: String(selection.includedUsers),
        monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
        monthlyAmountPence: String(selection.monthlyAmountPence),
        termsVersion: '2026-07-26',
      },
      subscription_data: {
        trial_period_days: planDefinition.trialDays ?? undefined,
        trial_settings: {
          end_behavior: {
            missing_payment_method: 'cancel',
          },
        },
        metadata: {
          organisationId: String(user.organisationId),
          planId: selection.planId,
          billingCycle,
          includedUsers: String(selection.includedUsers),
          monthlyDocumentLimit: String(selection.monthlyDocumentLimit),
          monthlyAmountPence: String(selection.monthlyAmountPence),
          termsVersion: '2026-07-26',
        },
      },
    });

    return jsonResponse(200, {
      success: true,
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'billing_checkout_failed';
    const message = error instanceof Error ? error.message : 'Could not start checkout.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
