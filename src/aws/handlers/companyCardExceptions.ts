import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { deleteCompanyCardEmployeeException, listTeamMembers, upsertCompanyCardEmployeeException } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { parseBoolean } from '../shared/helpers.js';

export async function upsertHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const companyCardId = Number(body.companyCardId);
    const employeeUserId = Number(body.employeeUserId);
    if (!Number.isFinite(companyCardId) || !Number.isFinite(employeeUserId)) {
      return jsonResponse(400, { success: false, error: 'invalid_company_card_exception', message: 'Choose both a company card and employee.' });
    }
    const employee = (await listTeamMembers(user)).find((member) => member.id === employeeUserId && member.role === 'Standard_Employee');
    if (!employee) {
      return jsonResponse(400, { success: false, error: 'invalid_company_card_exception_employee', message: 'Choose an employee in this organisation.' });
    }
    const exception = await upsertCompanyCardEmployeeException({
      id: Number.isFinite(Number(body.id)) ? Number(body.id) : undefined,
      organisationId: user.organisationId,
      companyCardId,
      employeeUserId,
      isActive: parseBoolean(String(body.isActive ?? 'true'), true),
    });
    return jsonResponse(200, { success: true, exception });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'save_company_card_exception_failed', message: error instanceof Error ? error.message : 'Could not save employee exception.' });
  }
}

export async function deleteHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const exceptionId = Number(event.pathParameters?.id);
    if (!Number.isFinite(exceptionId)) {
      return jsonResponse(400, { success: false, error: 'invalid_company_card_exception_id', message: 'A numeric employee exception id is required.' });
    }
    return jsonResponse(200, { success: true, result: await deleteCompanyCardEmployeeException(user.organisationId, exceptionId) });
  } catch (error) {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
    return jsonResponse(status, { success: false, error: 'delete_company_card_exception_failed', message: error instanceof Error ? error.message : 'Could not delete employee exception.' });
  }
}
