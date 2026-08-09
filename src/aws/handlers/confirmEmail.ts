import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { confirmRegisteredUserEmail } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';
import { signUserToken } from '../shared/auth.js';
import { awsEnv } from '../shared/env.js';

type ConfirmationEvent = APIGatewayProxyEventV2 & {
  httpMethod?: string;
};

export async function handler(event: ConfirmationEvent) {
  const requestMethod =
    event.requestContext?.http?.method ??
    event.httpMethod ??
    (event.body ? 'POST' : 'GET');
  const isGetRequest = requestMethod.toUpperCase() === 'GET';
  const query = event.queryStringParameters ?? {};
  const queryEmail = sanitizeText(query.email).toLowerCase();

  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const email = sanitizeText(isGetRequest ? query.email : body.email).toLowerCase();
    const confirmationToken = sanitizeText(isGetRequest ? query.token : body.token);

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

    if (isGetRequest) {
      const loginUrl = new URL(awsEnv.confirmEmailLoginUrl);
      loginUrl.searchParams.set('email', email);
      loginUrl.searchParams.set('confirmed', '1');
      return {
        statusCode: 302,
        headers: {
          Location: loginUrl.toString(),
          'Cache-Control': 'no-store',
        },
        body: '',
      };
    }

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

    if (isGetRequest) {
      const loginUrl = new URL(awsEnv.confirmEmailLoginUrl);
      if (queryEmail) {
        loginUrl.searchParams.set('email', queryEmail);
      }
      loginUrl.searchParams.set('confirmation', code === 'invalid_invite' ? 'used' : 'failed');
      return {
        statusCode: 302,
        headers: {
          Location: loginUrl.toString(),
          'Cache-Control': 'no-store',
        },
        body: '',
      };
    }

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
