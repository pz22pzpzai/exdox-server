import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';

export async function handler() {
  return jsonResponse(200, {
    ok: true,
    service: 'exdox-serverless-api',
    model: awsEnv.openAiModel,
    bucket: awsEnv.receiptBucketName,
    now: new Date().toISOString(),
  });
}
