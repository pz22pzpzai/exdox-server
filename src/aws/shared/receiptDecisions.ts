import { deleteReceiptObject, getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject } from './s3.js';
import type { ReceiptDecision } from './receiptDecisionPolicy.js';
export { decisionFromReceipt, isUnreviewedCost } from './receiptDecisionPolicy.js';

function decisionKey(organisationId: number, userId: number, receiptId: number) {
  return `receipt-decisions/org-${organisationId}/user-${userId}/receipt-${receiptId}.json`;
}

function dismissedPrefix(organisationId: number, userId: number) {
  return `receipt-decisions/org-${organisationId}/user-${userId}/dismissed/`;
}

function dismissedKey(organisationId: number, userId: number, receiptId: number) {
  return `${dismissedPrefix(organisationId, userId)}receipt-${receiptId}.json`;
}

export async function saveReceiptDecision(decision: ReceiptDecision) {
  await putReceiptJsonObject(decisionKey(decision.organisationId, decision.uploadedByUserId, decision.receiptId), decision);
  await deleteReceiptObject(dismissedKey(decision.organisationId, decision.uploadedByUserId, decision.receiptId));
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
  // Keep a marker so a legacy recycle-bin backfill cannot revive a notice
  // after the uploader has removed it from Purchases.
  await putReceiptJsonObject(dismissedKey(organisationId, userId, receiptId), { receiptId });
  await deleteReceiptObject(decisionKey(organisationId, userId, receiptId));
}

export async function listDismissedReceiptDecisionIds(organisationId: number, userId: number) {
  const keys = await listAllReceiptJsonKeys(dismissedPrefix(organisationId, userId));
  return new Set(keys.map((key) => Number(key.match(/receipt-(\d+)\.json$/)?.[1])).filter(Number.isFinite));
}

export async function listReceiptDecisions(organisationId: number, userId: number) {
  const prefix = `receipt-decisions/org-${organisationId}/user-${userId}/`;
  const keys = await listAllReceiptJsonKeys(prefix);
  const decisions = await Promise.all(keys.filter((key) => /^receipt-\d+\.json$/.test(key.slice(prefix.length))).map((key) => getReceiptJsonObject<ReceiptDecision>(key)));
  return decisions
    .filter((decision) => decision.organisationId === organisationId && decision.uploadedByUserId === userId)
    .sort((left, right) => right.decidedAt.localeCompare(left.decidedAt));
}
