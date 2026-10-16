import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { forbidden, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail, listPlatformWorkspaceOverview } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';

const platformAdminEmail = 'terryreedbfv@outlook.com';
const noStoreJsonResponse = (status: number, body: Record<string, unknown>) => {
  const response = jsonResponse(status, body);
  return { ...response, headers: { ...response.headers, 'Cache-Control': 'no-store' } };
};

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    if (user.email.trim().toLowerCase() !== platformAdminEmail || user.status !== 'active' || user.role !== 'Business_Admin') {
      throw forbidden('Platform admin access is restricted.');
    }
    const current = await findUserByEmail(platformAdminEmail);
    if (!current || current.id !== user.id || current.organisationId !== user.organisationId
      || current.status !== 'active' || current.role !== 'Business_Admin' || current.removedAt) {
      throw forbidden('Platform admin access is restricted.');
    }
    const workspaces = await listPlatformWorkspaceOverview();
    return noStoreJsonResponse(200, { success: true, workspaces });
  } catch (error) {
    const statusCode = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: string }).code)
      : 'platform_admin_failed';
    return noStoreJsonResponse(statusCode, {
      success: false,
      error: code,
      message: statusCode === 500 ? 'Could not load platform accounts.' : error instanceof Error ? error.message : 'Access denied.',
    });
  }
}
