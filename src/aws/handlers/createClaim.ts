import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { createExpenseClaim, getOrganisationSettings } from '../shared/db.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';
import { sanitizeText } from '../shared/helpers.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const claimType = body.claimType === 'mileage' ? 'mileage' : 'standard';
    const startPostcode = sanitizeText(body.startPostcode);
    const endPostcode = sanitizeText(body.endPostcode);
    const totalMiles = Number(body.totalMiles);
    const submittedMileageRate = Number(body.mileageRate);
    if (
      claimType === 'mileage' &&
      (!startPostcode || !endPostcode || !Number.isFinite(totalMiles) || totalMiles <= 0)
    ) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_mileage_claim',
        message: 'Provide a start postcode, end postcode, and a positive total miles value.',
      });
    }
    const organisationSettings = claimType === 'mileage' ? await getOrganisationSettings(user.organisationId) : null;
    const mileageRate = claimType === 'mileage'
      ? (Number.isFinite(submittedMileageRate) && submittedMileageRate > 0 && submittedMileageRate <= 100
        ? Number(submittedMileageRate.toFixed(4))
        : organisationSettings!.mileageRate)
      : null;
    const mileageTotalAmount = claimType === 'mileage' ? Number((totalMiles * mileageRate!).toFixed(2)) : null;
    const claim = await createExpenseClaim({
      organisationId: user.organisationId,
      createdByUserId: user.id,
      name: sanitizeText(body.name) || `${claimType === 'mileage' ? 'Mileage claim' : 'Expense Claim'} ${new Date().toISOString().slice(0, 10)}`,
      description: sanitizeText(body.description) || null,
      currency: sanitizeText(body.currency) || 'GBP',
      claimType,
      mileageStartPostcode: claimType === 'mileage' ? startPostcode : null,
      mileageEndPostcode: claimType === 'mileage' ? endPostcode : null,
      mileageTotalMiles: claimType === 'mileage' ? totalMiles : null,
      mileageRate,
      mileageTotalAmount,
    });

    return jsonResponse(200, {
      success: true,
      claim,
    });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'create_claim_failed';
    const message = error instanceof Error ? error.message : 'Could not create the expense claim.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
