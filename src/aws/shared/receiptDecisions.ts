import { deleteReceiptObject, getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject } from './s3.js';
import type { ReceiptDecision } from './receiptDecisionPolicy.js';
export { decisionFromReceipt, isUnreviewedCost } from './receiptDecisionPolicy.js';

function decisionKey(organisationId: number, userId: number, receiptId: number) {
  return `receipt-decisions/org-${organisationId}/user-${userId}/receipt-${receiptId}.json`;
}

export async function saveReceiptDecision(decision: ReceiptDecision) {
  await putReceiptJsonObject(decisionKey(decision.organisationId, decision.uploadedByUserId, decision.receiptId), decision);
}

export async function getReceiptDecision(organisationId: number, userId: number, receiptId: number) {
  try {
    return await getReceiptJsonObject<ReceiptDecision>(decisionKey(organisationId, userId, receiptId));
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'name' in error && ['NoSuchKey', 'NotFound'].includes(String(error.name))) return null;
    throw error;
  }
}

export async function deleteReceiptDecision(organisationId: number, userId: number, receiptId: number) {
  await deleteReceiptObject(decisionKey(organisationId, userId, receiptId));
}

export async function listReceiptDecisions(organisationId: number, userId: number) {
  const prefix = `receipt-decisions/org-${organisationId}/user-${userId}/`;
  const keys = await listAllReceiptJsonKeys(prefix);
  const decisions = await Promise.all(keys.filter((key) => key.endsWith('.json')).map((key) => getReceiptJsonObject<ReceiptDecision>(key)));
  return decisions
    .filter((decision) => decision.organisationId === organisationId && decision.uploadedByUserId === userId)
    .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}
