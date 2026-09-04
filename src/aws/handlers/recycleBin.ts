import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { listRecycleBinItems, restoreRecycleBinItem } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

export async function listHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const items = await listRecycleBinItems(user);
    return jsonResponse(200, { success: true, items });
  } catch (error) {
    return recycleBinError(error);
  }
}

export async function restoreHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const itemType = event.pathParameters?.type === 'claim' ? 'claim' : event.pathParameters?.type === 'receipt' ? 'receipt' : null;
    const itemId = Number(event.pathParameters?.id);
    if (!itemType || !Number.isFinite(itemId)) {
      return jsonResponse(400, { success: false, error: 'invalid_recycle_bin_item', message: 'Choose a deleted receipt or claim to restore.' });
    }
    await restoreRecycleBinItem(user, itemType, itemId);
    return jsonResponse(200, { success: true });
  } catch (error) {
    return recycleBinError(error);
  }
}

function recycleBinError(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : 500;
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: string }).code)
    : 'recycle_bin_failed';
  const message = error instanceof Error ? error.message : 'Could not access the recycle bin.';
  return jsonResponse(status, { success: false, error: code, message });
}
