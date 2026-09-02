import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { addClaimEvidence } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

const allowedMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxEvidenceBytes = 5 * 1024 * 1024;

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const claimId = Number(event.pathParameters?.id);
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const filename = typeof body.filename === 'string' ? body.filename : '';
    const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
    const base64 = typeof body.base64 === 'string' ? body.base64 : '';
    if (!Number.isFinite(claimId) || !filename || !allowedMimeTypes.has(mimeType) || !base64) {
      return jsonResponse(400, { success: false, error: 'invalid_claim_evidence', message: 'Provide a JPG, PNG, or WebP proof image.' });
    }
    const image = Buffer.from(base64, 'base64');
    if (!image.length || image.length > maxEvidenceBytes) {
      return jsonResponse(400, { success: false, error: 'invalid_claim_evidence_size', message: 'Proof images must be 5 MB or smaller.' });
    }
    const evidence = await addClaimEvidence({ user, claimId, filename, mimeType, body: image });
    return jsonResponse(200, { success: true, evidence });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'add_claim_evidence_failed', message: error instanceof Error ? error.message : 'Could not add journey proof.' });
  }
}
