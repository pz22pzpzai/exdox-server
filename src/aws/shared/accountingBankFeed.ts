import { createHash } from 'node:crypto';

export type BankFeedConnection = {
  provider: 'truelayer';
  environment: 'sandbox' | 'production';
  id: string;
  connectedAt: string;
  connectedBy: number;
  accounts: Array<{ remoteId: string; localId: string; label: string; lastSyncedAt?: string }>;
  authorization?: { id: string; createdAt: string };
  pending?: { remoteId: string; localId: string; from: string; to: string; requestId: string; cursor?: string };
};

export type BankFeedTransaction = {
  id: string;
  connectionId: string;
  remoteAccountId: string;
  localAccountId: string;
  providerTransactionId: string;
  date: string;
  description: string;
  amountPence: number;
  importedAt: string;
};

export type BankFeedMatch = { transactionId: string; bankEntryId: string; matchedAt: string; matchedBy: string };

const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export function normalizeFeedTransaction(value: unknown, connectionId: string, remoteAccountId: string, localAccountId: string): BankFeedTransaction | null {
  if (!value || typeof value !== 'object') throw new Error('Bank feed returned an invalid transaction.');
  const row = value as Record<string, unknown>;
  if (String(row.status).toLowerCase() === 'pending') return null;
  if (String(row.status).toLowerCase() !== 'settled') throw new Error('Bank feed returned a transaction with an unknown status.');
  const providerTransactionId = String(row.id ?? '').trim();
  const date = String(row.timestamp ?? '').slice(0, 10);
  const description = String(row.description ?? '').trim();
  const currency = String(row.currency ?? '');
  const amountPence = row.amount_in_minor;
  if (!providerTransactionId || !validDate(date) || !description || description.length > 240 || currency !== 'GBP' || typeof amountPence !== 'number' || !Number.isSafeInteger(amountPence) || amountPence === 0) throw new Error('Bank feed returned an incomplete GBP transaction.');
  const id = createHash('sha256').update(JSON.stringify([connectionId, remoteAccountId, providerTransactionId])).digest('hex');
  return { id, connectionId, remoteAccountId, localAccountId, providerTransactionId, date, description, amountPence, importedAt: new Date().toISOString() };
}
