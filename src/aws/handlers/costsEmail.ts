import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess, isBillingActive } from '../shared/billing.js';
import { getOrganisationBillingSummary } from '../shared/db.js';
import { getOrCreateCostsEmailAddress, listCostsEmailSubmissions, rotateCostsEmailAddress } from '../shared/costsEmailStore.js';
import { jsonResponse } from '../shared/http.js';

async function authorise(event: APIGatewayProxyEventV2) {
  const user = requireAuthenticatedUser(event);
  const billing = await getOrganisationBillingSummary(user.organisationId);
  if (!isBillingActive(billing)) throw Object.assign(new Error('This workspace needs an active plan.'), { statusCode: 402 });
  assertWorkspaceAccess(billing, 'cost');
  return user;
}

export async function listHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = await authorise(event);
    const [address, submissions] = await Promise.all([getOrCreateCostsEmailAddress(user), listCostsEmailSubmissions(user)]);
    return jsonResponse(200, { success: true, address, submissions });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'costs_email_failed', message: error instanceof Error ? error.message : 'Could not load Costs email settings.' });
  }
}

export async function rotateHandler(event: APIGatewayProxyEventV2) {
  try { return jsonResponse(200, { success: true, address: await rotateCostsEmailAddress(await authorise(event)) }); }
  catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'costs_email_failed', message: error instanceof Error ? error.message : 'Could not rotate Costs email address.' });
  }
}
