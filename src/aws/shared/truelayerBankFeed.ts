import { awsEnv } from './env.js';
import { liveBankFeedAllowed } from './liveBankFeedAccess.js';

type Result = Record<string, unknown>;

const sandbox = () => awsEnv.trueLayerDataEnvironment !== 'production';
export const bankFeedEnvironment = () => sandbox() ? 'sandbox' as const : 'production' as const;
export const bankFeedConfigured = () => liveBankFeedAllowed(bankFeedEnvironment(), awsEnv.trueLayerAisRegulatoryApproved, awsEnv.trueLayerDataClientId, awsEnv.trueLayerDataClientSecret);
const apiBase = () => sandbox() ? 'https://api.truelayer-sandbox.com' : 'https://api.truelayer.com';
const tokenUrl = () => sandbox() ? 'https://auth.truelayer-sandbox.com/connect/token' : 'https://auth.truelayer.com/connect/token';

async function accessToken(): Promise<string> {
  if (!bankFeedConfigured()) throw new Error('Live bank feed provider and regulatory approval are not configured.');
  const response = await fetch(tokenUrl(), { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: awsEnv.trueLayerDataClientId!, client_secret: awsEnv.trueLayerDataClientSecret!, scope: 'data' }), signal: AbortSignal.timeout(8_000) });
  if (!response.ok) throw new Error('Bank feed provider authentication failed.');
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error('Bank feed provider returned no access token.');
  return payload.access_token;
}

async function request(path: string, connectionId?: string, body?: Record<string, unknown>, userIp?: string): Promise<Result> {
  const response = await fetch(`${apiBase()}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${await accessToken()}`, Accept: 'application/json', ...(connectionId ? { 'Connection-Id': connectionId } : {}), ...(userIp && /^[0-9a-f:.]+$/i.test(userIp) ? { 'Tl-User-IP': userIp } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    const error = new Error(response.status === 401 || response.status === 403 ? 'Bank access needs to be reconnected.' : response.status === 429 ? 'Bank feed rate limit reached. Try later.' : 'Bank feed provider could not complete the request.') as Error & { providerStatus?: number };
    error.providerStatus = response.status;
    throw error;
  }
  return response.json() as Promise<Result>;
}

export async function createDataConnection(name: string, email: string, userIp?: string): Promise<{ id: string; url: string }> {
  const result = await request('/v3/data-connections', undefined, { scopes: ['accounts', 'transactions'], provider_selection: { type: 'user_selected', filter: { countries: ['GB'], customer_segments: ['business', 'retail'] } }, user: { name, email }, user_consent: { type: 'authorization_flow_captured' }, hosted_page: { type: 'authorization_flow', redirect: { return_uri: 'https://exdox.co.uk/accounting?bank=returned' } }, data_access_type: 'recurring' }, userIp);
  const id = String(result.id ?? '');
  const hosted = result.hosted_page as { uri?: string } | undefined;
  const url = hosted?.uri ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id) || !url.startsWith('https://')) throw new Error('Bank feed provider returned an incomplete connection.');
  const host = new URL(url).hostname;
  if (host !== 'app.truelayer.com' && host !== 'app.truelayer-sandbox.com') throw new Error('Bank feed provider returned an unexpected authorization address.');
  return { id, url };
}

export async function connectedAccounts(connectionId: string, userIp?: string): Promise<Array<{ id: string; currency: string; label: string }>> {
  const result = await request('/v3/connected-accounts', connectionId, undefined, userIp);
  const rows = result.items;
  if (!Array.isArray(rows)) throw new Error('Bank feed provider returned no account list.');
  return rows.filter((row): row is Record<string, unknown> => Boolean(row && typeof row === 'object')).map((row) => ({ id: String(row.id ?? ''), currency: String(row.currency ?? ''), label: `${String(row.account_type ?? 'Bank account')} ${String(row.id ?? '').slice(-6)}` })).filter((row) => /^[0-9a-f-]{32,36}$/i.test(row.id));
}

export async function startTransactions(connectionId: string, accountId: string, from: string, to: string, cursor?: string, userIp?: string): Promise<string> {
  const result = await request(`/v3/connected-accounts/${encodeURIComponent(accountId)}/transactions/requests`, connectionId, { from, to, page_size: 50, ...(cursor ? { cursor } : {}) }, userIp);
  const id = String(result.id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('Bank feed provider did not create a transaction request.');
  return id;
}

export async function readTransactions(connectionId: string, accountId: string, requestId: string, userIp?: string): Promise<{ status: 'pending' | 'completed' | 'failed'; items: unknown[]; nextCursor?: string }> {
  const result = await request(`/v3/connected-accounts/${encodeURIComponent(accountId)}/transactions/requests/${encodeURIComponent(requestId)}`, connectionId, undefined, userIp);
  const status = String(result.status);
  if (!['pending', 'completed', 'failed'].includes(status)) throw new Error('Bank feed provider returned an unknown transaction status.');
  const body = result.result as { items?: unknown[]; pagination?: { next_cursor?: string | null }; next_cursor?: string | null } | undefined;
  if (status === 'completed' && (!Array.isArray(body?.items) || !body?.pagination || typeof body.pagination !== 'object')) throw new Error('Bank feed provider returned an incomplete transaction page.');
  return { status: status as 'pending' | 'completed' | 'failed', items: Array.isArray(body?.items) ? body.items : [], nextCursor: body?.pagination?.next_cursor ?? body?.next_cursor ?? undefined };
}
