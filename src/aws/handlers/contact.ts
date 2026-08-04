import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { sendContactEmail } from '../shared/contactMail.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const fullName = sanitizeText(body.fullName);
    const email = sanitizeText(body.email).toLowerCase();
    const organisationName = sanitizeText(body.organisationName) || null;
    const subject = sanitizeText(body.subject) || 'General enquiry';
    const message = sanitizeText(body.message);

    if (!fullName) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_full_name',
        message: 'Enter your full name.',
      });
    }

    if (!email) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_email',
        message: 'Enter your email address.',
      });
    }

    if (!emailPattern.test(email)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_email',
        message: 'Enter a valid email address.',
      });
    }

    if (!message) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_message',
        message: 'Enter a message before sending.',
      });
    }

    const delivery = await sendContactEmail({
      fullName,
      email,
      organisationName,
      subject,
      message,
    });

    if (!delivery.delivered) {
      return jsonResponse(503, {
        success: false,
        error: 'contact_delivery_unavailable',
        message: 'The contact form is not available right now. Please email contact@exdox.co.uk directly.',
      });
    }

    return jsonResponse(200, {
      success: true,
      delivered: true,
      message: 'Your message has been sent to the Exdox team.',
    });
  } catch (error) {
    const statusCode =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'contact_failed';
    const message = error instanceof Error ? error.message : 'Could not send the contact message.';

    return jsonResponse(statusCode, {
      success: false,
      error: code,
      message,
    });
  }
}
