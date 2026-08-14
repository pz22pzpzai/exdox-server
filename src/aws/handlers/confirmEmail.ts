import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { confirmRegisteredUserEmail, getOrganisationName } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';
import { signUserToken } from '../shared/auth.js';
import { awsEnv } from '../shared/env.js';
import { sendWorkspaceWelcomeEmail } from '../shared/confirmationMail.js';

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
  if (isGetRequest) {
    // Existing messages may still point at this API URL. Hand them off to the
    // website without consuming the token so the browser can complete the flow.
    const handoffUrl = new URL(awsEnv.confirmEmailBaseUrl);
    const queryEmail = sanitizeText(query.email).toLowerCase();
    const queryToken = sanitizeText(query.token);
    if (queryEmail) {
      handoffUrl.searchParams.set('email', queryEmail);
    }
    if (queryToken) {
      handoffUrl.searchParams.set('token', queryToken);
    }
    return {
      statusCode: 302,
      headers: {
        Location: handoffUrl.toString(),
        'Cache-Control': 'no-store',
      },
      body: '',
    };
  }

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

    const confirmation = await confirmRegisteredUserEmail({
      email,
      confirmationToken,
    });
    const { user } = confirmation;

    if (!confirmation.alreadyConfirmed) {
      try {
        await sendWorkspaceWelcomeEmail({
          toEmail: user.email,
          fullName: user.fullName,
          organisationName: await getOrganisationName(user.organisationId),
        });
      } catch (error) {
        console.warn('Could not send the workspace welcome email.', {
          email: user.email,
          message: error instanceof Error ? error.message : 'Unknown email error',
        });
      }
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

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
