import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { confirmRegisteredUserEmail } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';
import { signUserToken } from '../shared/auth.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(body.email).toLowerCase();
    const confirmationToken = sanitizeText(body.token);

    if (!email || !confirmationToken) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_confirmation_details',
        message: 'Email address and confirmation token are required.',
      });
    }

    const user = await confirmRegisteredUserEmail({
      email,
      confirmationToken,
    });

    return jsonResponse(200, {
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
        : 'confirmation_failed';
    const message = error instanceof Error ? error.message : 'Email confirmation failed.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
