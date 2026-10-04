import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import jwt from 'jsonwebtoken';
import { forbidden, requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail } from '../shared/db.js';
import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';
import { getReceiptJsonObject, putReceiptJsonObject } from '../shared/s3.js';

const ownerEmail = 'terryreedbfv@outlook.com';
const redirectUri = 'https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/accounting/hmrc/callback';
const authorizeUrl = 'https://test-www.tax.service.gov.uk/oauth/authorize';
const tokenUrl = 'https://test-api.service.hmrc.gov.uk/oauth/token';
type Tokens = { access_token: string; refresh_token: string; expires_in: number; scope: string; token_type: string };
type Connection = { version: 1; connectedAt: string; connectedBy: number; accessTokenExpiresAt: string; encryptedTokens: { iv: string; tag: string; ciphertext: string } };
type ConnectState = { purpose: 'accounting_hmrc_sandbox'; userId: number; organisationId: number };

function key(organisationId: number) { return `accounting/org-${organisationId}/hmrc/sandbox-connection.json`; }
function configured() { return Boolean(awsEnv.hmrcVatSandboxClientId && awsEnv.hmrcVatSandboxClientSecret); }
function cryptoKey() { return createHash('sha256').update(`${awsEnv.jwtSecret}:accounting-hmrc-sandbox:v1`).digest(); }
function encrypt(tokens: Tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', cryptoKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}
async function owner(event: APIGatewayProxyEventV2) {
  const user = requireAuthenticatedUser(event);
  if (user.email.trim().toLowerCase() !== ownerEmail || user.status !== 'active') throw forbidden('Accounting is locked for this account.');
  const current = await findUserByEmail(ownerEmail);
  if (!current || current.id !== user.id || current.organisationId !== user.organisationId || current.status !== 'active') throw forbidden('Accounting is locked for this account.');
  return user;
}
async function connectionFor(organisationId: number): Promise<Connection | null> {
  try { return await getReceiptJsonObject<Connection>(key(organisationId)); }
  catch (error) {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (value.name === 'NoSuchKey' || value.name === 'NotFound' || value.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
function failure(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  return jsonResponse(status, { success: false, message: status === 500 ? 'Could not connect to HMRC sandbox.' : error instanceof Error ? error.message : 'Request failed.' });
}
function returnToAccounting(result: 'connected' | 'failed' | 'denied') {
  return { statusCode: 302, headers: { Location: `https://exdox.co.uk/accounting?hmrc=${result}`, 'Cache-Control': 'no-store' }, body: '' };
}

export async function statusHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = await owner(event);
    const connection = await connectionFor(user.organisationId);
    return jsonResponse(200, { success: true, environment: 'sandbox', configured: configured(), connected: Boolean(connection), connectedAt: connection?.connectedAt ?? null, redirectUri, obligationsAvailable: false, submissionAvailable: false });
  } catch (error) { return failure(error); }
}

export async function connectHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = await owner(event);
    if (!configured()) return jsonResponse(409, { success: false, message: 'HMRC sandbox credentials have not been configured on the server.' });
    const state = jwt.sign({ purpose: 'accounting_hmrc_sandbox', userId: user.id, organisationId: user.organisationId } satisfies ConnectState, awsEnv.jwtSecret, { expiresIn: '10m' });
    const url = new URL(authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', awsEnv.hmrcVatSandboxClientId!);
    url.searchParams.set('scope', 'read:vat write:vat');
    url.searchParams.set('state', state);
    url.searchParams.set('redirect_uri', redirectUri);
    return jsonResponse(200, { success: true, authorizationUrl: url.toString() });
  } catch (error) { return failure(error); }
}

export async function callbackHandler(event: APIGatewayProxyEventV2) {
  try {
    const code = event.queryStringParameters?.code?.trim();
    const state = event.queryStringParameters?.state?.trim();
    if (!code || !state || !configured()) return returnToAccounting(event.queryStringParameters?.error === 'access_denied' ? 'denied' : 'failed');
    const decoded = jwt.verify(state, awsEnv.jwtSecret) as jwt.JwtPayload & Partial<ConnectState>;
    if (decoded.purpose !== 'accounting_hmrc_sandbox' || !Number.isSafeInteger(decoded.userId) || !Number.isSafeInteger(decoded.organisationId)) return returnToAccounting('failed');
    const current = await findUserByEmail(ownerEmail);
    if (!current || current.id !== decoded.userId || current.organisationId !== decoded.organisationId || current.status !== 'active') return returnToAccounting('failed');
    const response = await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: awsEnv.hmrcVatSandboxClientId!, client_secret: awsEnv.hmrcVatSandboxClientSecret!, grant_type: 'authorization_code', redirect_uri: redirectUri, code }) });
    if (!response.ok) return returnToAccounting('failed');
    const tokens = await response.json() as Tokens;
    if (!tokens.access_token || !tokens.refresh_token || !Number.isFinite(tokens.expires_in)) return returnToAccounting('failed');
    // Token values are encrypted before S3 persistence and never returned to the browser.
    await putReceiptJsonObject(key(current.organisationId), { version: 1, connectedAt: new Date().toISOString(), connectedBy: current.id, accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), encryptedTokens: encrypt(tokens) } satisfies Connection);
    return returnToAccounting('connected');
  } catch { return returnToAccounting('failed'); }
}
