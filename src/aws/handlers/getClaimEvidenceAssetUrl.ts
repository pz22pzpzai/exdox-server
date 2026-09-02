import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { listClaimEvidence } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { createReceiptDownloadUrl } from '../shared/s3.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const claimId = Number(event.pathParameters?.id);
    const evidenceId = event.pathParameters?.evidenceId;
    if (!Number.isFinite(claimId) || !evidenceId) {
      return jsonResponse(400, { success: false, error: 'invalid_claim_evidence_id', message: 'A claim and proof image are required.' });
    }
    const evidence = (await listClaimEvidence(user, claimId)).find((item) => item.id === evidenceId);
    if (!evidence) return jsonResponse(404, { success: false, error: 'claim_evidence_not_found', message: 'Journey proof was not found.' });
    const preview = await createReceiptDownloadUrl({ key: evidence.s3Key, fileName: evidence.sourceFilename, disposition: 'inline' });
    return jsonResponse(200, { success: true, asset: { previewUrl: preview.downloadUrl } });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'claim_evidence_asset_failed', message: error instanceof Error ? error.message : 'Could not load journey proof.' });
  }
}
