import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createDepartment, listDepartments, listTeamMembers, updateTeamMemberDepartment } from '../shared/db.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const method = event.requestContext.http.method;

    if (method === 'GET') {
      const [departments, members] = await Promise.all([listDepartments(user), listTeamMembers(user)]);
      return jsonResponse(200, { success: true, departments, members });
    }

    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    if (method === 'POST') {
      const department = await createDepartment(user, sanitizeText(body.name));
      return jsonResponse(201, { success: true, department });
    }

    if (method === 'PUT') {
      const userId = Number(body.userId);
      const departmentId = body.departmentId === null || body.departmentId === undefined || body.departmentId === ''
        ? null
        : Number(body.departmentId);
      if (!Number.isInteger(userId) || userId <= 0 || (departmentId !== null && (!Number.isInteger(departmentId) || departmentId <= 0))) {
        return jsonResponse(400, { success: false, error: 'invalid_team_update', message: 'Choose a valid team member and department.' });
      }
      await updateTeamMemberDepartment(user, userId, departmentId);
      return jsonResponse(200, { success: true });
    }

    return jsonResponse(405, { success: false, error: 'method_not_allowed', message: 'Method not allowed.' });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error
      ? Number((error as { statusCode?: number }).statusCode)
      : 500;
    return jsonResponse(status, {
      success: false,
      error: 'team_management_failed',
      message: error instanceof Error ? error.message : 'Could not update the team.',
    });
  }
}
