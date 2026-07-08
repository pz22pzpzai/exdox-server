import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { completeBankRequisition } from '../shared/db.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const state = sanitizeText(event.queryStringParameters?.state);
    if (!state) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_state',
        message: 'The bank callback state is required.',
      });
    }

    const externalRequisitionId =
      sanitizeText(event.queryStringParameters?.requisition_id) ||
      sanitizeText(event.queryStringParameters?.consent_id) ||
      null;

    await completeBankRequisition({
      callbackState: state,
      externalRequisitionId,
    });

    return jsonResponse(200, {
      success: true,
      linked: true,
      state,
      externalRequisitionId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not complete bank callback.';
    return jsonResponse(500, {
      success: false,
      error: 'bank_callback_failed',
      message,
    });
  }
}
