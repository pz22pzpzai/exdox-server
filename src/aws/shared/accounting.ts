import { randomUUID } from 'node:crypto';

export type AccountType = 'asset' | 'liability' | 'equity' | 'income' | 'expense';
export type LedgerAccount = { id: string; code: string; name: string; type: AccountType; system?: boolean };
export type JournalLine = { accountId: string; debitPence: number; creditPence: number };
export type JournalEntry = { id: string; date: string; reference: string; description: string; lines: JournalLine[]; createdAt: string; createdBy: string };

export const defaultAccounts: LedgerAccount[] = [
  { id: '1000', code: '1000', name: 'Bank', type: 'asset', system: true },
  { id: '1100', code: '1100', name: 'Accounts receivable', type: 'asset', system: true },
  { id: '1200', code: '1200', name: 'VAT receivable', type: 'asset', system: true },
  { id: '2000', code: '2000', name: 'Accounts payable', type: 'liability', system: true },
  { id: '2100', code: '2100', name: 'VAT payable', type: 'liability', system: true },
  { id: '3000', code: '3000', name: 'Owner capital', type: 'equity', system: true },
  { id: '3100', code: '3100', name: 'Retained earnings', type: 'equity', system: true },
  { id: '4000', code: '4000', name: 'Sales', type: 'income', system: true },
  { id: '5000', code: '5000', name: 'Cost of sales', type: 'expense', system: true },
  { id: '6000', code: '6000', name: 'Operating expenses', type: 'expense', system: true },
];

export function createAccount(input: unknown, existing: LedgerAccount[]): LedgerAccount {
  const data = input as Record<string, unknown>;
  const code = String(data?.code ?? '').trim();
  const name = String(data?.name ?? '').trim();
  const type = data?.type;
  if (!/^\d{4,6}$/.test(code) || name.length < 2 || name.length > 100 || !['asset', 'liability', 'equity', 'income', 'expense'].includes(String(type))) {
    throw new Error('Enter a 4–6 digit code, a name, and a valid account type.');
  }
  if (existing.some((account) => account.code === code)) throw new Error('That account code already exists.');
  return { id: randomUUID(), code, name, type: type as AccountType };
}

export function createJournal(input: unknown, accounts: LedgerAccount[], createdBy: string): JournalEntry {
  const data = input as Record<string, unknown>;
  const date = String(data?.date ?? '');
  const description = String(data?.description ?? '').trim();
  const reference = String(data?.reference ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || description.length < 3 || description.length > 240 || reference.length > 80) {
    throw new Error('Enter a valid date and a description of 3–240 characters.');
  }
  if (!Array.isArray(data?.lines) || data.lines.length < 2 || data.lines.length > 50) throw new Error('A journal needs 2–50 lines.');
  const allowed = new Set(accounts.map((account) => account.id));
  const lines = data.lines.map((raw: unknown) => {
    const line = raw as Record<string, unknown>;
    const accountId = String(line?.accountId ?? '');
    const debitPence = Number(line?.debitPence ?? 0);
    const creditPence = Number(line?.creditPence ?? 0);
    if (!allowed.has(accountId) || !Number.isSafeInteger(debitPence) || !Number.isSafeInteger(creditPence) || debitPence < 0 || creditPence < 0 || (debitPence > 0) === (creditPence > 0)) {
      throw new Error('Each line needs one valid account and exactly one positive debit or credit.');
    }
    return { accountId, debitPence, creditPence };
  });
  const debits = lines.reduce((sum, line) => sum + line.debitPence, 0);
  const credits = lines.reduce((sum, line) => sum + line.creditPence, 0);
  if (!Number.isSafeInteger(debits) || debits === 0 || debits !== credits) throw new Error('Debits and credits must balance exactly.');
  return { id: randomUUID(), date, reference, description, lines, createdAt: new Date().toISOString(), createdBy };
}

export function ledgerReport(accounts: LedgerAccount[], entries: JournalEntry[], through?: string) {
  const selected = through ? entries.filter((entry) => entry.date <= through) : entries;
  const balances = accounts.map((account) => {
    const debitPence = selected.reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountId === account.id).reduce((total, line) => total + line.debitPence, 0), 0);
    const creditPence = selected.reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountId === account.id).reduce((total, line) => total + line.creditPence, 0), 0);
    return { ...account, debitPence, creditPence, balancePence: debitPence - creditPence };
  });
  const net = (type: AccountType) => balances.filter((account) => account.type === type).reduce((sum, account) => sum + account.balancePence, 0);
  const profitPence = -net('income') - net('expense');
  return { balances, profitPence, assetsPence: net('asset'), liabilitiesPence: -net('liability'), equityPence: -net('equity') + profitPence, journalCount: selected.length };
}
