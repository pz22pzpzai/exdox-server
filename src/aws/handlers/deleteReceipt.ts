import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAuthenticatedUser } from '../shared/auth.js';
import { assertWorkspaceAccess } from '../shared/billing.js';
import { deleteReceiptById, getOrganisationBillingSummary, getReceiptById } from '../shared/db.js';
import { jsonResponse } from '../shared/http.js';
import { decisionFromReceipt, deleteReceiptDecision, getReceiptDecision, isUnreviewedCost, saveReceiptDecision } from '../shared/receiptDecisions.js';

export async function handler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const receiptId = Number(event.pathParameters?.id ?? event.queryStringParameters?.id);
    if (!Number.isFinite(receiptId)) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_receipt_id',
        message: 'A numeric receipt id is required.',
      });
    }

    const employeeDecision = user.role === 'Business_Admin' ? null : await getReceiptDecision(user.organisationId, user.id, receiptId);
    if (employeeDecision && user.role !== 'Business_Admin') {
      if (employeeDecision.action === 'rejected') {
        try {
          const rejectedReceipt = await getReceiptById(user, receiptId);
          if (rejectedReceipt.status === 'Rejected') await deleteReceiptById(user, receiptId);
        } catch (error) {
          if (!(typeof error === 'object' && error !== null && 'statusCode' in error && Number(error.statusCode) === 404)) throw error;
        }
      }
      await deleteReceiptDecision(user.organisationId, user.id, receiptId);
      return jsonResponse(200, { success: true, result: { dismissed: true } });
    }

    const [billing, receipt] = await Promise.all([
      getOrganisationBillingSummary(user.organisationId),
      getReceiptById(user, receiptId),
    ]);
    assertWorkspaceAccess(billing, receipt.workspaceContext);
    const notifyUploader = user.role === 'Business_Admin'
      && receipt.uploadedByUserId !== user.id
      && (isUnreviewedCost(receipt) || (receipt.workspaceContext === 'cost' && receipt.status === 'Rejected'));
    const previousDecision = notifyUploader
      ? await getReceiptDecision(user.organisationId, receipt.uploadedByUserId, receiptId)
      : null;
    if (notifyUploader) await saveReceiptDecision(decisionFromReceipt(receipt, 'deleted'));
    let result;
    try {
      result = await deleteReceiptById(user, receiptId);
    } catch (error) {
      if (notifyUploader) {
        if (previousDecision) await saveReceiptDecision(previousDecision);
        else await deleteReceiptDecision(user.organisationId, receipt.uploadedByUserId, receiptId);
      }
      throw error;
    }
    return jsonResponse(200, {
      success: true,
      result,
    });
  } catch (error) {
    const status =
      typeof error === 'object' && error !== null && 'statusCode' in error
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: string }).code)
        : 'delete_receipt_failed';
    const message = error instanceof Error ? error.message : 'Could not delete the receipt.';
    return jsonResponse(status, {
      success: false,
      error: code,
      message,
    });
  }
}
