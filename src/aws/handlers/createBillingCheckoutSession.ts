import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createSelfServeCheckoutSession } from '../shared/billingCheckout.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const checkout = await createSelfServeCheckoutSession({
      user,
      planId: body.planId,
      billingCycle: body.billingCycle,
    });

    return jsonResponse(200, {
      success: true,
      ...checkout,
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
