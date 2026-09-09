import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';

import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import jwt from 'jsonwebtoken';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptJsonObject, getReceiptObjectBuffer, putReceiptJsonObject } from '../shared/s3.js';
import { getOrganisationSettings, getReceiptById, listExpenseClaims, listReceiptsByClaim, updateClaimStatus, updateReceiptById } from '../shared/db.js';
import { getSalesDocumentPdf, getSalesWorkspace, markSalesDocumentPublishedToXero, saveSalesCustomer } from '../shared/salesWorkspaceStore.js';

const XERO_AUTHORIZE_URL = 'https://login.xero.com/identity/connect/authorize';
const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token';
const XERO_CONNECTIONS_URL = 'https://api.xero.com/connections';
const XERO_REDIRECT_URI = 'https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/xero/callback';
const XERO_SCOPES = ['offline_access', 'accounting.contacts', 'accounting.invoices', 'accounting.payments', 'accounting.banktransactions', 'accounting.settings.read', 'accounting.attachments'];

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
  availableTenants?: XeroConnectionResponse[];
};
type XeroAccount = { AccountID: string; Code: string; Name: string; Type: string; Status: string };
type XeroTaxRate = { Name: string; TaxType: string; Status: string; CanApplyToExpenses?: boolean; CanApplyToRevenue?: boolean };
type XeroTrackingCategory = { TrackingCategoryID: string; Name: string; Status: string; Options?: Array<{ TrackingOptionID: string; Name: string; Status: string }> };
type XeroContact = { ContactID: string; Name: string; EmailAddress?: string; IsSupplier?: boolean; IsCustomer?: boolean };
type XeroItem = { ItemID: string; Code: string; Name?: string; IsSold?: boolean; IsPurchased?: boolean };
type XeroUser = { UserID: string; FirstName?: string; LastName?: string; EmailAddress?: string; IsSubscriber?: boolean };
type XeroIntegrationSettings = {
  purchaseAccountCode: string | null;
  salesAccountCode: string | null;
  purchaseTaxType: string | null;
  salesTaxType: string | null;
  purchaseStatus: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED';
  salesStatus: 'DRAFT' | 'SUBMITTED' | 'AUTHORISED';
  publishAttachments: boolean;
};
type XeroPublication = { sourceType: 'receipt' | 'sales_document' | 'claim'; sourceId: string; xeroType: string; xeroId: string; xeroNumber: string | null; publishedAt: string };

const DEFAULT_XERO_SETTINGS: XeroIntegrationSettings = { purchaseAccountCode: null, salesAccountCode: null, purchaseTaxType: null, salesTaxType: null, purchaseStatus: 'DRAFT', salesStatus: 'DRAFT', publishAttachments: true };

function connectionKey(organisationId: number) { return `xero-connections/org-${organisationId}.json`; }
function settingsKey(organisationId: number) { return `xero-connections/org-${organisationId}-settings.json`; }
function publicationKey(organisationId: number, sourceType: XeroPublication['sourceType'], sourceId: string) { return `xero-publications/org-${organisationId}/${sourceType}-${sourceId}.json`; }
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
  return { statusCode: 302, headers: { Location: `https://exdox.co.uk/settings/integrations?xero=${result}`, 'Cache-Control': 'no-store' }, body: '' };
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
  if (!connection) throw new Error('Connect Xero before using accounting integration features.');
  if (Date.parse(connection.accessTokenExpiresAt) > Date.now() + 60_000) return { connection, accessToken: decryptXeroTokens(connection).access_token };
  const previousTokens = decryptXeroTokens(connection);
  if (!previousTokens.refresh_token) throw new Error('Reconnect Xero before using accounting integration features.');
  const basic = Buffer.from(`${awsEnv.xeroClientId}:${awsEnv.xeroClientSecret}`).toString('base64');
  const refreshResponse = await fetch(XERO_TOKEN_URL, { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: previousTokens.refresh_token }) });
  if (!refreshResponse.ok) throw new Error('Reconnect Xero before using accounting integration features.');
  const refreshedPayload = await refreshResponse.json() as XeroTokenResponse;
  const refreshedTokens = { ...refreshedPayload, refresh_token: refreshedPayload.refresh_token ?? previousTokens.refresh_token };
  const refreshedConnection: StoredXeroConnection = { ...connection, accessTokenExpiresAt: new Date(Date.now() + refreshedTokens.expires_in * 1000).toISOString(), encryptedTokens: encryptTokens(refreshedTokens) };
  await putReceiptJsonObject(connectionKey(organisationId), refreshedConnection);
  return { connection: refreshedConnection, accessToken: refreshedTokens.access_token };
}

async function loadSettings(organisationId: number) {
  try { return { ...DEFAULT_XERO_SETTINGS, ...(await getReceiptJsonObject<Partial<XeroIntegrationSettings>>(settingsKey(organisationId))) }; }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') return { ...DEFAULT_XERO_SETTINGS };
    throw error;
  }
}

async function loadPublication(organisationId: number, sourceType: XeroPublication['sourceType'], sourceId: string) {
  try { return await getReceiptJsonObject<XeroPublication>(publicationKey(organisationId, sourceType, sourceId)); }
  catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    if (status === 404 || (error as { name?: string }).name === 'NoSuchKey') return null;
    throw error;
  }
}

async function xeroGet<T>(organisationId: number, path: string) {
  return xeroGetWithAuth<T>(await accessTokenFor(organisationId), path);
}

async function xeroGetWithAuth<T>(auth: Awaited<ReturnType<typeof accessTokenFor>>, path: string) {
  const { connection, accessToken } = auth;
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, { headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': connection.tenantId, Accept: 'application/json' } });
  if (!response.ok) throw new Error('Xero could not refresh the requested accounting data. Reconnect Xero and try again.');
  return await response.json() as T;
}

async function loadXeroContacts(auth: Awaited<ReturnType<typeof accessTokenFor>>) {
  const contacts: XeroContact[] = [];
  for (let page = 1; page <= 30; page += 1) {
    const payload = await xeroGetWithAuth<{ Contacts?: XeroContact[] }>(auth, `Contacts?page=${page}`);
    const next = payload.Contacts ?? [];
    contacts.push(...next);
    if (next.length < 100) break;
  }
  return { Contacts: contacts };
}

async function xeroPost<T>(organisationId: number, path: string, body: unknown) {
  const { connection, accessToken } = await accessTokenFor(organisationId);
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': connection.tenantId, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { Elements?: Array<{ ValidationErrors?: Array<{ Message?: string }> }> } | null;
    const validation = payload?.Elements?.flatMap((item) => item.ValidationErrors ?? []).map((item) => item.Message).filter(Boolean).join(' ');
    throw new Error(validation || 'Xero rejected this item. Check the account, tax, contact, dates, and document values.');
  }
  return await response.json() as T;
}

async function findOrCreateContact(organisationId: number, name: string, email?: string | null) {
  const escaped = name.replace(/"/g, '\\"');
  const result = await xeroGet<{ Contacts?: XeroContact[] }>(organisationId, `Contacts?where=${encodeURIComponent(`Name==\"${escaped}\"`)}`);
  const existing = result.Contacts?.[0];
  if (existing) return existing;
  const created = await xeroPost<{ Contacts?: XeroContact[] }>(organisationId, 'Contacts', { Contacts: [{ Name: name, ...(email ? { EmailAddress: email } : {}) }] });
  const contact = created.Contacts?.[0];
  if (!contact?.ContactID) throw new Error('Xero did not return the contact it created.');
  return contact;
}

function safeDate(value: string | null | undefined) { return value?.slice(0, 10) || new Date().toISOString().slice(0, 10); }
function xeroLine(description: string, amount: number, accountCode: string, taxType: string | null, quantity = 1) {
  return { Description: description.slice(0, 4000), Quantity: quantity, UnitAmount: Number(amount.toFixed(2)), AccountCode: accountCode, ...(taxType ? { TaxType: taxType } : {}) };
}

async function uploadAttachment(organisationId: number, xeroType: 'Invoices' | 'CreditNotes', xeroId: string, filename: string, contentType: string, body: Buffer) {
  const { connection, accessToken } = await accessTokenFor(organisationId);
  const safeName = filename.replace(/[\\/?%*:|"<>]/g, '_').slice(0, 100) || 'source-document';
  const response = await fetch(`https://api.xero.com/api.xro/2.0/${xeroType}/${xeroId}/Attachments/${safeName}`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'xero-tenant-id': connection.tenantId, 'Content-Type': contentType, Accept: 'application/json' }, body: new Uint8Array(body) });
  if (!response.ok) throw new Error('The item reached Xero, but its source document could not be attached.');
}

export async function statusHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const connection = await loadConnection(user.organisationId);
    return jsonResponse(200, { success: true, configured: configured(), connected: Boolean(connection), tenantId: connection?.tenantId ?? null, tenantName: connection?.tenantName ?? null, connectedAt: connection?.connectedAt ?? null, availableTenants: (connection?.availableTenants ?? []).map((tenant) => ({ tenantId: tenant.tenantId, tenantName: tenant.tenantName })) });
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
    const connections = await connectionsResponse.json() as XeroConnectionResponse[];
    const connection = connections[0];
    if (!connection?.tenantId || !connection.tenantName) throw new Error('No Xero organisation was selected. Please try again and choose an organisation.');
    await putReceiptJsonObject(connectionKey(Number(decoded.organisationId)), { version: 1, tenantId: connection.tenantId, tenantName: connection.tenantName, tenantType: connection.tenantType, connectedAt: new Date().toISOString(), connectedByUserId: Number(decoded.userId), accessTokenExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(), encryptedTokens: encryptTokens(tokens), availableTenants: connections } satisfies StoredXeroConnection);
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

export async function selectTenantHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? JSON.parse(event.body) as { tenantId?: string } : {};
    const connection = await loadConnection(user.organisationId);
    if (!connection) throw new Error('Connect Xero before choosing an organisation.');
    const selected = (connection.availableTenants ?? []).find((tenant) => tenant.tenantId === body.tenantId);
    if (!selected) throw new Error('Choose an organisation authorised for this Xero connection.');
    await putReceiptJsonObject(connectionKey(user.organisationId), { ...connection, tenantId: selected.tenantId, tenantName: selected.tenantName, tenantType: selected.tenantType });
    return jsonResponse(200, { success: true, tenantId: selected.tenantId, tenantName: selected.tenantName });
  } catch (error) { return xeroError(error, 'Could not change the connected Xero organisation.'); }
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

export async function importCustomersHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const auth = await accessTokenFor(user.organisationId);
    const contacts = (await loadXeroContacts(auth)).Contacts ?? [];
    const workspace = await getSalesWorkspace(user);
    const existingNames = new Set(workspace.customers.map((customer) => customer.name.trim().toLowerCase()));
    const organisation = await getOrganisationSettings(user.organisationId);
    let imported = 0;
    let alreadyPresent = 0;
    for (const contact of contacts.filter((item) => item.IsCustomer || (!item.IsCustomer && !item.IsSupplier)).slice(0, 1000)) {
      if (existingNames.has(contact.Name.trim().toLowerCase())) { alreadyPresent += 1; continue; }
      await saveSalesCustomer(user, { name: contact.Name, email: contact.EmailAddress ?? null, currency: organisation.baseCurrency, active: true });
      existingNames.add(contact.Name.trim().toLowerCase());
      imported += 1;
    }
    return jsonResponse(200, { success: true, imported, alreadyPresent });
  } catch (error) { return xeroError(error, 'Could not import Xero customers into Exdox.'); }
}

export async function referenceDataHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const auth = await accessTokenFor(user.organisationId);
    const [accountsPayload, taxPayload, trackingPayload, contactsPayload, itemsPayload, currenciesPayload, usersPayload, settings] = await Promise.all([
      xeroGetWithAuth<{ Accounts?: XeroAccount[] }>(auth, 'Accounts'),
      xeroGetWithAuth<{ TaxRates?: XeroTaxRate[] }>(auth, 'TaxRates'),
      xeroGetWithAuth<{ TrackingCategories?: XeroTrackingCategory[] }>(auth, 'TrackingCategories'),
      loadXeroContacts(auth),
      xeroGetWithAuth<{ Items?: XeroItem[] }>(auth, 'Items'),
      xeroGetWithAuth<{ Currencies?: Array<{ Code: string; Description?: string }> }>(auth, 'Currencies'),
      xeroGetWithAuth<{ Users?: XeroUser[] }>(auth, 'Users'),
      loadSettings(user.organisationId),
    ]);
    const accounts = (accountsPayload.Accounts ?? []).filter((item) => item.Status === 'ACTIVE' && item.Code).map(({ AccountID, Code, Name, Type }) => ({ accountId: AccountID, code: Code, name: Name, type: Type }));
    const taxRates = (taxPayload.TaxRates ?? []).filter((item) => item.Status === 'ACTIVE').map(({ Name, TaxType, CanApplyToExpenses, CanApplyToRevenue }) => ({ name: Name, taxType: TaxType, canApplyToExpenses: Boolean(CanApplyToExpenses), canApplyToRevenue: Boolean(CanApplyToRevenue) }));
    const trackingCategories = (trackingPayload.TrackingCategories ?? []).filter((item) => item.Status === 'ACTIVE').map((item) => ({ trackingCategoryId: item.TrackingCategoryID, name: item.Name, options: (item.Options ?? []).filter((option) => option.Status === 'ACTIVE').map((option) => ({ trackingOptionId: option.TrackingOptionID, name: option.Name })) }));
    const contacts = (contactsPayload.Contacts ?? []).map(({ ContactID, Name, EmailAddress, IsSupplier, IsCustomer }) => ({ contactId: ContactID, name: Name, emailAddress: EmailAddress ?? null, isSupplier: Boolean(IsSupplier), isCustomer: Boolean(IsCustomer) }));
    const items = (itemsPayload.Items ?? []).map((item) => ({ itemId: item.ItemID, code: item.Code, name: item.Name ?? item.Code, isSold: Boolean(item.IsSold), isPurchased: Boolean(item.IsPurchased) }));
    const currencies = (currenciesPayload.Currencies ?? []).map((currency) => ({ code: currency.Code, description: currency.Description ?? currency.Code }));
    const users = (usersPayload.Users ?? []).map((xeroUser) => ({ userId: xeroUser.UserID, name: `${xeroUser.FirstName ?? ''} ${xeroUser.LastName ?? ''}`.trim() || xeroUser.EmailAddress || 'Xero user', emailAddress: xeroUser.EmailAddress ?? null, isSubscriber: Boolean(xeroUser.IsSubscriber) }));
    return jsonResponse(200, { success: true, accounts, bankAccounts: accounts.filter((item) => item.type === 'BANK'), taxRates, trackingCategories, contacts, items, currencies, users, settings, refreshedAt: new Date().toISOString() });
  } catch (error) { return xeroError(error, 'Could not refresh Xero accounting lists.'); }
}

export async function getIntegrationSettingsHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    return jsonResponse(200, { success: true, settings: await loadSettings(user.organisationId) });
  } catch (error) { return xeroError(error, 'Could not load Xero settings.'); }
}

export async function updateIntegrationSettingsHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const input = event.body ? JSON.parse(event.body) as Partial<XeroIntegrationSettings> : {};
    const status = (value: unknown, fallback: XeroIntegrationSettings['purchaseStatus']) => value === 'DRAFT' || value === 'SUBMITTED' || value === 'AUTHORISED' ? value : fallback;
    const settings: XeroIntegrationSettings = {
      purchaseAccountCode: typeof input.purchaseAccountCode === 'string' && input.purchaseAccountCode.trim() ? input.purchaseAccountCode.trim() : null,
      salesAccountCode: typeof input.salesAccountCode === 'string' && input.salesAccountCode.trim() ? input.salesAccountCode.trim() : null,
      purchaseTaxType: typeof input.purchaseTaxType === 'string' && input.purchaseTaxType.trim() ? input.purchaseTaxType.trim() : null,
      salesTaxType: typeof input.salesTaxType === 'string' && input.salesTaxType.trim() ? input.salesTaxType.trim() : null,
      purchaseStatus: status(input.purchaseStatus, 'DRAFT'),
      salesStatus: status(input.salesStatus, 'DRAFT'),
      publishAttachments: input.publishAttachments !== false,
    };
    await putReceiptJsonObject(settingsKey(user.organisationId), settings);
    return jsonResponse(200, { success: true, settings });
  } catch (error) { return xeroError(error, 'Could not save Xero settings.'); }
}

export async function publishHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const input = event.body ? JSON.parse(event.body) as { sourceType?: XeroPublication['sourceType']; sourceId?: string | number } : {};
    const sourceType = input.sourceType;
    const sourceId = String(input.sourceId ?? '').trim();
    if (!sourceType || !['receipt', 'sales_document', 'claim'].includes(sourceType) || !sourceId) throw new Error('Choose an Exdox cost, sale, or claim to publish.');
    const previous = await loadPublication(user.organisationId, sourceType, sourceId);
    if (previous) return jsonResponse(200, { success: true, alreadyPublished: true, publication: previous });
    const settings = await loadSettings(user.organisationId);
    const publishInvoice = async (invoice: Record<string, unknown>, attachment?: { filename: string; contentType: string; body: Buffer }) => {
      const response = await xeroPost<{ Invoices?: Array<{ InvoiceID: string; InvoiceNumber?: string }> }>(user.organisationId, 'Invoices', { Invoices: [invoice] });
      const created = response.Invoices?.[0];
      if (!created?.InvoiceID) throw new Error('Xero did not return the invoice it created.');
      let warning: string | null = null;
      if (settings.publishAttachments && attachment) {
        try { await uploadAttachment(user.organisationId, 'Invoices', created.InvoiceID, attachment.filename, attachment.contentType, attachment.body); }
        catch (attachmentError) { warning = attachmentError instanceof Error ? attachmentError.message : 'The source document could not be attached in Xero.'; }
      }
      return { xeroId: created.InvoiceID, xeroNumber: created.InvoiceNumber ?? null, warning };
    };
    let result: { xeroId: string; xeroNumber: string | null; warning?: string | null };
    let xeroType = 'Invoice';
    if (sourceType === 'receipt') {
      const receipt = await getReceiptById(user, Number(sourceId));
      if (receipt.workspaceContext === 'vault') throw new Error('Vault files are evidence only and cannot be published to Xero.');
      if (receipt.status !== 'Ready' && receipt.status !== 'Published') throw new Error('Approve this document before publishing it to Xero.');
      const isCost = receipt.workspaceContext === 'cost';
      const accountCode = isCost ? settings.purchaseAccountCode : settings.salesAccountCode;
      if (!accountCode) throw new Error(`Choose a default Xero ${isCost ? 'cost' : 'sales'} account in Integrations first.`);
      const contactName = (isCost ? receipt.vendorName : receipt.customer || receipt.vendorName)?.trim();
      if (!contactName) throw new Error(`Add a ${isCost ? 'supplier' : 'customer'} before publishing to Xero.`);
      const contact = await findOrCreateContact(user.organisationId, contactName);
      const net = receipt.netAmount ?? Math.max(0, Number(receipt.totalAmount ?? 0) - Number(receipt.vatAmount ?? 0));
      result = await publishInvoice({ Type: isCost ? 'ACCPAY' : 'ACCREC', Contact: { ContactID: contact.ContactID }, Date: safeDate(receipt.invoiceDate), DueDate: safeDate(receipt.dueDate ?? receipt.invoiceDate), CurrencyCode: receipt.currency || receipt.baseCurrency, Reference: `Exdox ${receipt.id}`, ...(receipt.invoiceNumber ? { InvoiceNumber: receipt.invoiceNumber } : {}), Status: isCost ? settings.purchaseStatus : settings.salesStatus, LineAmountTypes: 'Exclusive', LineItems: [xeroLine(receipt.description || receipt.category || receipt.sourceFilename, net, accountCode, isCost ? settings.purchaseTaxType : settings.salesTaxType)] }, { filename: receipt.sourceFilename, contentType: receipt.sourceMimeType, body: await getReceiptObjectBuffer(receipt.s3Key) });
      await updateReceiptById(user, receipt.id, { status: 'Published' });
    } else if (sourceType === 'sales_document') {
      const document = (await getSalesWorkspace(user)).documents.find((item) => item.id === sourceId);
      if (!document) throw new Error('Sales document not found.');
      if (document.kind === 'quote') throw new Error('Convert the quote to an invoice before publishing it to Xero.');
      if (!settings.salesAccountCode) throw new Error('Choose a default Xero sales account in Integrations first.');
      const customer = (await getSalesWorkspace(user)).customers.find((item) => item.id === document.customerId);
      const contact = await findOrCreateContact(user.organisationId, document.customerName, customer?.email);
      if (document.kind === 'credit_note') {
        const response = await xeroPost<{ CreditNotes?: Array<{ CreditNoteID: string; CreditNoteNumber?: string }> }>(user.organisationId, 'CreditNotes', { CreditNotes: [{ Type: 'ACCRECCREDIT', Contact: { ContactID: contact.ContactID }, Date: safeDate(document.issueDate), CurrencyCode: document.currency, Reference: document.number, Status: settings.salesStatus, LineAmountTypes: 'Exclusive', LineItems: document.lineItems.map((line) => xeroLine(line.description, line.unitPrice, settings.salesAccountCode!, settings.salesTaxType, line.quantity)) }] });
        const created = response.CreditNotes?.[0];
        if (!created?.CreditNoteID) throw new Error('Xero did not return the credit note it created.');
        result = { xeroId: created.CreditNoteID, xeroNumber: created.CreditNoteNumber ?? null, warning: null };
        xeroType = 'CreditNote';
      } else {
        const pdf = await getSalesDocumentPdf(user, document.id);
        result = await publishInvoice({ Type: 'ACCREC', Contact: { ContactID: contact.ContactID }, Date: safeDate(document.issueDate), DueDate: safeDate(document.dueDate), CurrencyCode: document.currency, InvoiceNumber: document.number, Reference: `Exdox ${document.id}`, Status: settings.salesStatus, LineAmountTypes: 'Exclusive', LineItems: document.lineItems.map((line) => xeroLine(line.description, line.unitPrice, settings.salesAccountCode!, settings.salesTaxType, line.quantity)) }, { filename: `${document.number}.pdf`, contentType: 'application/pdf', body: await getReceiptObjectBuffer(pdf.pdfKey) });
      }
      await markSalesDocumentPublishedToXero(user, document.id, result.xeroId, result.xeroNumber);
    } else {
      const claimId = Number(sourceId);
      const claim = (await listExpenseClaims(user, 200)).find((item) => item.id === claimId);
      if (!claim) throw new Error('Expense claim not found.');
      if (claim.status !== 'approved' && claim.status !== 'published') throw new Error('Approve this claim before publishing it to Xero.');
      if (!settings.purchaseAccountCode) throw new Error('Choose a default Xero cost account in Integrations first.');
      const receipts = await listReceiptsByClaim(user, claimId);
      const contact = await findOrCreateContact(user.organisationId, claim.claimantName || claim.claimantEmail || `Exdox claimant ${claim.createdByUserId}`, claim.claimantEmail);
      const lines = receipts.length ? receipts.map((receipt) => xeroLine(receipt.description || receipt.vendorName || receipt.sourceFilename, receipt.netAmount ?? Math.max(0, Number(receipt.totalAmount ?? 0) - Number(receipt.vatAmount ?? 0)), settings.purchaseAccountCode!, settings.purchaseTaxType)) : [xeroLine(claim.description || claim.name, claim.totalAmount, settings.purchaseAccountCode, settings.purchaseTaxType)];
      result = await publishInvoice({ Type: 'ACCPAY', Contact: { ContactID: contact.ContactID }, Date: safeDate(claim.createdAt), DueDate: safeDate(claim.createdAt), CurrencyCode: claim.currency, Reference: `Exdox claim ${claim.id}`, Status: settings.purchaseStatus, LineAmountTypes: 'Exclusive', LineItems: lines }, receipts[0] ? { filename: receipts[0].sourceFilename, contentType: receipts[0].sourceMimeType, body: await getReceiptObjectBuffer(receipts[0].s3Key) } : undefined);
      await updateClaimStatus(user, claim.id, 'published');
    }
    const publication: XeroPublication = { sourceType, sourceId, xeroType, xeroId: result.xeroId, xeroNumber: result.xeroNumber, publishedAt: new Date().toISOString() };
    await putReceiptJsonObject(publicationKey(user.organisationId, sourceType, sourceId), publication);
    return jsonResponse(200, { success: true, alreadyPublished: false, publication, warning: result.warning ?? null });
  } catch (error) { return xeroError(error, 'Could not publish this item to Xero.'); }
}
