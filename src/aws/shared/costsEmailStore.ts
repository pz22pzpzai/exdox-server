import crypto from 'node:crypto';

import type { AuthenticatedUser } from '../types.js';
import { deleteReceiptObject, deleteReceiptPrefix, getReceiptJsonObject, listAllReceiptJsonKeys, listReceiptJsonKeys, putReceiptJsonObject } from './s3.js';

const ROOT = 'costs-email';
const DOMAIN = 'costs.exdox.co.uk';

export type CostsEmailAddress = { organisationId: number; userId: number; code: string; address: string; createdAt: string };
export type CostsEmailSubmission = {
  id: string;
  organisationId: number;
  userId: number;
  receivedAt: string;
  subject: string;
  status: 'completed' | 'partial' | 'duplicate' | 'failed';
  receiptIds: number[];
  failures: string[];
};

function addressKey(organisationId: number, userId: number) { return `${ROOT}/org-${organisationId}/user-${userId}/address.json`; }
function lookupKey(code: string) { return `${ROOT}/by-code/${code}.json`; }
function submissionKey(organisationId: number, userId: number, id: string) { return `${ROOT}/org-${organisationId}/user-${userId}/submissions/${id}.json`; }

async function readOptional<T>(key: string): Promise<T | null> {
  try { return await getReceiptJsonObject<T>(key); }
  catch (error) {
    const name = error instanceof Error ? error.name : '';
    const status = typeof error === 'object' && error !== null && '$metadata' in error
      ? Number((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode) : 0;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return null;
    throw error;
  }
}

export async function getOrCreateCostsEmailAddress(user: AuthenticatedUser): Promise<CostsEmailAddress> {
  const key = addressKey(user.organisationId, user.id);
  const existing = await readOptional<CostsEmailAddress>(key);
  if (existing) return existing;
  const code = crypto.randomBytes(16).toString('hex');
  const row = { organisationId: user.organisationId, userId: user.id, code, address: `costs-${code}@${DOMAIN}`, createdAt: new Date().toISOString() };
  await putReceiptJsonObject(lookupKey(code), row);
  await putReceiptJsonObject(key, row);
  return row;
}

export async function rotateCostsEmailAddress(user: AuthenticatedUser): Promise<CostsEmailAddress> {
  const old = await readOptional<CostsEmailAddress>(addressKey(user.organisationId, user.id));
  const code = crypto.randomBytes(16).toString('hex');
  const row = { organisationId: user.organisationId, userId: user.id, code, address: `costs-${code}@${DOMAIN}`, createdAt: new Date().toISOString() };
  await putReceiptJsonObject(lookupKey(code), row);
  await putReceiptJsonObject(addressKey(user.organisationId, user.id), row);
  if (old) await deleteReceiptObject(lookupKey(old.code));
  return row;
}

export async function findCostsEmailAddress(recipient: string): Promise<CostsEmailAddress | null> {
  const match = /^costs-([a-f0-9]{32})@costs\.exdox\.co\.uk$/i.exec(recipient.trim());
  if (!match) return null;
  const row = await readOptional<CostsEmailAddress>(lookupKey(match[1].toLowerCase()));
  if (row?.address.toLowerCase() !== recipient.trim().toLowerCase()) return null;
  const current = await readOptional<CostsEmailAddress>(addressKey(row.organisationId, row.userId));
  return current?.code === row.code ? row : null;
}

export async function saveCostsEmailSubmission(row: CostsEmailSubmission): Promise<void> {
  await putReceiptJsonObject(submissionKey(row.organisationId, row.userId, row.id), row);
}

export async function getCostsEmailSubmission(organisationId: number, userId: number, id: string): Promise<CostsEmailSubmission | null> {
  return readOptional<CostsEmailSubmission>(submissionKey(organisationId, userId, id));
}

export async function listCostsEmailSubmissions(user: AuthenticatedUser): Promise<CostsEmailSubmission[]> {
  const keys = await listReceiptJsonKeys(`${ROOT}/org-${user.organisationId}/user-${user.id}/submissions/`, 100);
  const rows = await Promise.all(keys.map((key) => readOptional<CostsEmailSubmission>(key)));
  return rows.filter((row): row is CostsEmailSubmission => Boolean(row)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)).slice(0, 30);
}

export async function deleteCostsEmailForOrganisation(organisationId: number): Promise<void> {
  const keys = await listAllReceiptJsonKeys(`${ROOT}/org-${organisationId}/`);
  const addressKeys = keys.filter((key) => key.endsWith('/address.json'));
  const addresses = await Promise.all(addressKeys.map((key) => readOptional<CostsEmailAddress>(key)));
  await Promise.all(addresses.filter((item): item is CostsEmailAddress => Boolean(item)).map((item) => deleteReceiptObject(lookupKey(item.code))));
  await deleteReceiptPrefix(`${ROOT}/org-${organisationId}/`);
}
