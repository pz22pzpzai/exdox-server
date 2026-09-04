import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { findUserById, updateClaimDetails, updateClaimStatus } from '../shared/db.js';
import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { assertFeatureAccess } from '../shared/billing.js';
import { getOrganisationBillingSummary } from '../shared/db.js';
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
    const hasStatus = Object.hasOwn(body, 'status');
    const status = sanitizeText(body.status);
    const hasDetails = ['name', 'description', 'currency', 'startPostcode', 'endPostcode', 'totalMiles', 'mileageRate']
      .some((field) => Object.hasOwn(body, field));
    if (!hasStatus && !hasDetails) {
      return jsonResponse(400, {
        success: false,
        error: 'missing_claim_update',
        message: 'Provide claim details or a claim status to update.',
      });
    }
    if (!hasStatus) {
      const claim = await updateClaimDetails(user, claimId, {
        name: Object.hasOwn(body, 'name') ? sanitizeText(body.name) : undefined,
        description: Object.hasOwn(body, 'description') ? sanitizeText(body.description) || null : undefined,
        currency: Object.hasOwn(body, 'currency') ? sanitizeText(body.currency).toUpperCase() : undefined,
        mileageStartPostcode: Object.hasOwn(body, 'startPostcode') ? sanitizeText(body.startPostcode) : undefined,
        mileageEndPostcode: Object.hasOwn(body, 'endPostcode') ? sanitizeText(body.endPostcode) : undefined,
        mileageTotalMiles: Object.hasOwn(body, 'totalMiles') ? Number(body.totalMiles) : undefined,
        mileageRate: Object.hasOwn(body, 'mileageRate') ? Number(body.mileageRate) : undefined,
      });
      return jsonResponse(200, { success: true, claim });
    }
    if (!['pending', 'approved', 'payment_processing', 'paid', 'rejected'].includes(status)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_claim_status',
        message: 'Use pending, approved, payment_processing, paid, or rejected as the claim status.',
      });
    }
    if (status !== 'pending') {
      const billing = await getOrganisationBillingSummary(user.organisationId);
      assertFeatureAccess(
        billing,
        'approval_workflows',
        'Your current plan does not include approval workflows. Upgrade to Control or Operations to approve claims.',
      );
    }
    const claim = await updateClaimStatus(user, claimId, status as 'pending' | 'approved' | 'payment_processing' | 'paid' | 'rejected');
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
