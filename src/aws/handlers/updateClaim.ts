import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { findUserById, updateClaimStatus } from '../shared/db.js';
import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { sendClaimStatusEmail } from '../shared/claimMail.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const claimId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(claimId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_claim_id',
        message: 'A numeric claim id is required.',
      });
    }

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const status = sanitizeText(body.status);
    if (!['pending', 'approved', 'paid', 'rejected'].includes(status)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_claim_status',
        message: 'Use pending, approved, paid, or rejected as the claim status.',
      });
    }
    const claim = await updateClaimStatus(user, claimId, status as 'pending' | 'approved' | 'paid' | 'rejected');
    let notificationDelivered = false;
    if (status === 'approved' || status === 'paid' || status === 'rejected') {
      const claimant = await findUserById(user.organisationId, claim.createdByUserId);
      if (claimant) {
        try {
          await sendClaimStatusEmail({
            toEmail: claimant.email,
            fullName: claimant.fullName,
            claimName: claim.name,
            status,
          });
          notificationDelivered = true;
        } catch (notificationError) {
          console.error('Claim status changed but claimant notification failed.', {
            claimId,
            claimantUserId: claimant.id,
            message: notificationError instanceof Error ? notificationError.message : 'Unknown email error',
          });
        }
      }
    }

    return jsonResponse(200, {
      success: true,
      claim,
      notificationDelivered,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'update_claim_failed';
    const message = error instanceof Error ? error.message : 'Could not update the claim.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
