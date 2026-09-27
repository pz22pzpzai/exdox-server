import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { jsonResponse } from '../shared/http.js';
import { calculateMileageRoutes, MileageRoutingError } from '../shared/mileageRouting.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    requireAuthenticatedUser(event);
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = event.body ? JSON.parse(event.body) : {};
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request body');
      body = parsed as Record<string, unknown>;
    } catch {
      return jsonResponse(400, { success: false, error: 'invalid_request', message: 'Provide the journey postcodes.' });
    }
    const result = await calculateMileageRoutes(body.startPostcode, body.endPostcode, process.env.MAPBOX_ACCESS_TOKEN ?? '', fetch, body.includeMap === true);
    return jsonResponse(200, { success: true, ...result });
  } catch (error) {
    if (error instanceof MileageRoutingError) {
      return jsonResponse(error.statusCode, { success: false, error: error.code, message: error.message });
    }
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'mileage_route_failed';
    return jsonResponse(status, { success: false, error: code, message: status === 500 ? 'Could not calculate the driving route.' : error instanceof Error ? error.message : 'Could not calculate the driving route.' });
  }
}
