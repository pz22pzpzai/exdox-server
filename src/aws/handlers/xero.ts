import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import jwt from 'jsonwebtoken';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptJsonObject, putReceiptJsonObject } from '../shared/s3.js';
import { getSalesWorkspace } from '../shared/salesWorkspaceStore.js';

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_REDIRECT_URI = 'https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/xero/callback';
const XERO_SCOPES = ['offline_access', 'accounting.contacts', 'accounting.invoices', 'accounting.settings.read'];

type XeroConnectState = { purpose: 'xero_connect'; organisationId: number; userId: number };
type XeroTokenResponse = { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope?: string };
type XeroConnectionResponse = { tenantId: string; tenantName: string; tenantType: string };
type StoredXeroConnection = {
  version: 1;
  tenantId: string;
  tenantName: string;
  tenantType: string;
  connectedAt: string;
  connectedByUserId: number;
  accessTokenExpiresAt: string;
  encryptedTokens: { iv: string; tag: string; ciphertext: string };
};

function connectionKey(organisationId: number) { return `xero-connections/org-${organisationId}.json`; }
function configured() { return Boolean(awsEnv.xeroClientId && awsEnv.xeroClientSecret); }
function encryptionKey() { return createHash('sha256').update(`${awsEnv.jwtSecret}:xero-token-encryption:v1`).digest(); }

function encryptTokens(tokens: XeroTokenResponse) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

export function decryptXeroTokens(record: StoredXeroConnection): XeroTokenResponse {
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(record.encryptedTokens.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(record.encryptedTokens.tag, 'base64'));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(record.encryptedTokens.ciphertext, 'base64')), decipher.final()]).toString('utf8');
  return JSON.parse(plaintext) as XeroTokenResponse;
}

function xeroError(error: unknown, fallback: string) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  return jsonResponse(status, { success: false, error: typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'xero_integration_failed', message: error instanceof Error ? error.message : fallback });
}

function redirectToSettings(result: 'connected' | 'failed') {
  return { statusCode: 302, headers: { Location: `https://exdox.co.uk/settings?xero=${result}`, 'Cache-Control': 'no-store' }, body: '' };
}

async function loadConnection(organisationId: number) {
  try {
    return await getReceiptJsonObject<StoredXeroConnection>(connectionKey(organisationId));
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name?: string }).name) : '';
    if (code === 'NoSuchKey' || code === 'NotFound') return null;
    throw error;
  }
}

async function accessTokenFor(organisationId: number) {
  const connection = await loadConnection(organisationId);
  if (!connection) throw new Error('Connect Xero before syncing customers.');
  if (Date.parse(connection.accessTokenExpiresAt) > Date.now() + 60_000) return { connection, accessToken: decryptXeroTokens(connection).access_token };
  const previousTokens = decryptXeroTokens(connection);
  if (!previousTokens.refresh_token) throw new Error('Reconnect Xero before syncing customers.');
  const basic = Buffer.from(`${awsEnv.xeroClientId}:${awsEnv.xeroClientSecret}`).toString('base64');
  const refreshResponse = await fetch(XERO_TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previousTokens.refresh_token }) });
  if (!refreshResponse.ok) throw new Error('Reconnect Xero before syncing customers.');
  const refreshedTokens = await refreshResponse.json() as XeroTokenResponse;
  const refreshedConnection: StoredXeroConnection = { ...connection, accessTokenExpiresAt: new Date(Date.now() + refreshedTokens.expires_in * 1000).toISOString(), encryptedTokens: encryptTokens(refreshedTokens) };
  await putReceiptJsonObject(connectionKey(organisationId), refreshedConnection);
  return { connection: refreshedConnection, accessToken: refreshedTokens.access_token };
}

export async function statusHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const connection = await loadConnection(user.organisationId);
    return jsonResponse(200, { success: true, configured: configured(), connected: Boolean(connection), tenantName: connection?.tenantName ?? null, connectedAt: connection?.connectedAt ?? null });
  } catch (error) { return xeroError(error, 'Could not load the Xero connection.'); }
}

export async function connectHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    if (!configured()) throw new Error('Xero is not configured for this Exdox environment yet.');
    const state = jwt.sign({ purpose: 'xero_connect', organisationId: user.organisationId, userId: user.id } satisfies XeroConnectState, awsEnv.jwtSecret, { expiresIn: '10m' });
    const url = new URL(XERO_AUTHORIZE_URL);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', awsEnv.xeroClientId!);
    url.searchParams.set('redirect_uri', XERO_REDIRECT_URI);
    url.searchParams.set('scope', XERO_SCOPES.join(' '));
    url.searchParams.set('state', state);
    return jsonResponse(200, { success: true, authorizationUrl: url.toString() });
  } catch (error) { return xeroError(error, 'Could not start the Xero connection.'); }
}

export async function callbackHandler(event: APIGatewayProxyEventV2) {
  try {
    if (!configured()) throw new Error('Xero is not configured for this Exdox environment yet.');
    const code = event.queryStringParameters?.code?.trim();
    const state = event.queryStringParameters?.state?.trim();
    if (!code || !state) throw new Error('The Xero connection was not completed.');
    const decoded = jwt.verify(state, awsEnv.jwtSecret) as jwt.JwtPayload & Partial<XeroConnectState>;
    if (decoded.purpose !== 'xero_connect' || !Number.isFinite(Number(decoded.organisationId)) || Number(decoded.organisationId) <= 0 || !Number.isFinite(Number(decoded.userId)) || Number(decoded.userId) <= 0) throw new Error('The Xero connection request is invalid or has expired.');
    const basic = Buffer.from(`${awsEnv.xeroClientId}:${awsEnv.xeroClientSecret}`).toString('base64');
    const tokenResponse = await fetch(XERO_TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: XERO_REDIRECT_URI }) });
    if (!tokenResponse.ok) throw new Error('Xero did not accept the connection. Please try again.');
    const tokens = await tokenResponse.json() as XeroTokenResponse;
    if (!tokens.access_token || !tokens.expires_in) throw new Error('Xero returned an incomplete connection response.');
    const connectionsResponse = await fetch(XERO_CONNECTIONS_URL, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
    if (!connectionsResponse.ok) throw new Error('Xero did not return an organisation connection. Please try again.');
    const connection = (await connectionsResponse.json() as XeroConnectionResponse[])[0];
    if (!connection?.tenantId || !connection.tenantName) throw new Error('No Xero organisation was selected. Please try again and choose an organisation.');
    await putReceiptJsonObject(connectionKey(Number(decoded.organisationId)), { version: 1, tenantId: connection.tenantId, tenantName: connection.tenantName, tenantType: connection.tenantType, connectedAt: new Date().toISOString(), connectedByUserId: Number(decoded.userId), accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), encryptedTokens: encryptTokens(tokens) } satisfies StoredXeroConnection);
    return redirectToSettings('connected');
  } catch { return redirectToSettings('failed'); }
}

export async function disconnectHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    await deleteReceiptObject(connectionKey(user.organisationId));
    return jsonResponse(200, { success: true });
  } catch (error) { return xeroError(error, 'Could not disconnect Xero.'); }
}

export async function syncCustomersHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const { connection, accessToken } = await accessTokenFor(user.organisationId);
    const { customers } = await getSalesWorkspace(user);
    let created = 0;
    let alreadyPresent = 0;
    for (const customer of customers.filter((item) => item.active)) {
      const lookup = await fetch(`https://api.xero.com/api.xro/2.0/Contacts?where=${encodeURIComponent(`Name==\"${customer.name.replace(/\"/g, '\\\"')}\"`)}`, { headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': connection.tenantId, Accept: 'application/json' } });
      if (!lookup.ok) throw new Error(`Xero could not look up ${customer.name}.`);
      const matching = await lookup.json() as { Contacts?: unknown[] };
      if (matching.Contacts?.length) { alreadyPresent += 1; continue; }
      const create = await fetch('https://api.xero.com/api.xro/2.0/Contacts', { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': connection.tenantId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ Contacts: [{ Name: customer.name, ...(customer.email ? { EmailAddress: customer.email } : {}), ...(customer.phone ? { Phones: [{ PhoneType: 'DEFAULT', PhoneNumber: customer.phone }] } : {}) }] }) });
      if (!create.ok) throw new Error(`Xero could not create ${customer.name}.`);
      created += 1;
    }
    return jsonResponse(200, { success: true, created, alreadyPresent, total: customers.filter((item) => item.active).length });
  } catch (error) { return xeroError(error, 'Could not sync customers to Xero.'); }
}
