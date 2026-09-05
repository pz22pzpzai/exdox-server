import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createDepartment, listDepartments, listTeamMembers, updateTeamMemberDepartment } from '../shared/db.js';
import { sanitizeText } from '../shared/helpers.js';
import { jsonResponse } from '../shared/http.js';

export async function listHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const [departments, members] = await Promise.all([listDepartments(user), listTeamMembers(user)]);
    return jsonResponse(200, { success: true, departments, members });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

export async function createDepartmentHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const department = await createDepartment(user, sanitizeText(body.name));
    return jsonResponse(201, { success: true, department });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

export async function assignDepartmentHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? (JSON.parse(event.body) as Record<string, unknown>) : {};
    const userId = Number(body.userId);
    const departmentId = body.departmentId === null || body.departmentId === undefined || body.departmentId === ''
      ? null
      : Number(body.departmentId);
    if (!Number.isInteger(userId) || userId <= 0 || (departmentId !== null && (!Number.isInteger(departmentId) || departmentId <= 0))) {
      return jsonResponse(400, { success: false, error: 'invalid_team_update', message: 'Choose a valid team member and department.' });
    }
    await updateTeamMemberDepartment(user, userId, departmentId);
    return jsonResponse(200, { success: true });
  } catch (error) {
    return teamErrorResponse(error);
  }
}

function teamErrorResponse(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error
    ? Number((error as { statusCode?: number }).statusCode)
    : 500;
  return jsonResponse(status, {
    success: false,
    error: 'team_management_failed',
    message: error instanceof Error ? error.message : 'Could not update the team.',
  });
}
