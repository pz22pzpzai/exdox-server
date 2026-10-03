import { createHash } from 'node:crypto';
import type { JournalEntry } from './accounting.js';

export type StatementLine = { index: number; date: string; description: string; reference: string; amountPence: number };
export type BankStatement = { id: string; name: string; openingPence: number; closingPence: number; fromDate: string; toDate: string; lines: StatementLine[]; importedAt: string; importedBy: string };
export type BankMatch = { statementId: string; lineIndex: number; bankEntryId: string; amountPence: number; matchedAt: string; matchedBy: string };
export type BankEntry = { id: string; date: string; reference: string; description: string; amountPence: number };

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function createBankStatement(input: unknown, importedBy: string): BankStatement {
  const data = input as Record<string, unknown>;
  const name = String(data?.name ?? '').trim();
  const openingPence = Number(data?.openingPence);
  const closingPence = Number(data?.closingPence);
  if (!name || name.length > 120 || !Number.isSafeInteger(openingPence) || !Number.isSafeInteger(closingPence)) throw new Error('Enter a statement name and valid opening and closing balances.');
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > 500) throw new Error('A statement needs 1–500 transactions.');
  const lines = data.lines.map((value: unknown, index: number) => {
    const row = value as Record<string, unknown>;
    const date = String(row?.date ?? '');
    const description = String(row?.description ?? '').trim();
    const reference = String(row?.reference ?? '').trim();
    const amountPence = Number(row?.amountPence);
    if (!validDate(date) || !description || description.length > 240 || reference.length > 100 || !Number.isSafeInteger(amountPence) || amountPence === 0) throw new Error(`Statement row ${index + 1} has an invalid date, description, or amount.`);
    return { index, date, description, reference, amountPence };
  });
  const total = lines.reduce((sum, line) => sum + line.amountPence, openingPence);
  if (!Number.isSafeInteger(total) || total !== closingPence) throw new Error('Opening balance plus statement transactions must equal the closing balance.');
  const dates = lines.map((line) => line.date).sort();
  const hash = createHash('sha256').update(JSON.stringify({ name, openingPence, closingPence, lines })).digest('hex');
  return { id: hash, name, openingPence, closingPence, fromDate: dates[0], toDate: dates[dates.length - 1], lines, importedAt: new Date().toISOString(), importedBy };
}

export function bankEntries(entries: JournalEntry[]): BankEntry[] {
  return entries.flatMap((entry) => entry.lines.flatMap((line, index) => line.accountId === '1000' ? [{
    id: `${entry.id}:${index}`,
    date: entry.date,
    reference: entry.reference,
    description: entry.description,
    amountPence: line.debitPence - line.creditPence,
  }] : []));
}

export function createBankMatch(input: unknown, statements: BankStatement[], entries: BankEntry[], existing: BankMatch[], matchedBy: string): BankMatch {
  const data = input as Record<string, unknown>;
  const statementId = String(data?.statementId ?? '');
  const lineIndex = Number(data?.lineIndex);
  const bankEntryId = String(data?.bankEntryId ?? '');
  const statement = statements.find((item) => item.id === statementId);
  const line = statement?.lines.find((item) => item.index === lineIndex);
  const bankEntry = entries.find((item) => item.id === bankEntryId);
  if (!line || !bankEntry) throw new Error('Choose a valid statement line and bank transaction.');
  if (line.amountPence !== bankEntry.amountPence) throw new Error('Statement and ledger bank amounts must match exactly.');
  if (existing.some((match) => match.statementId === statementId && match.lineIndex === lineIndex)) throw new Error('That statement line is already matched.');
  if (existing.some((match) => match.bankEntryId === bankEntryId)) throw new Error('That ledger transaction is already matched.');
  return { statementId, lineIndex, bankEntryId, amountPence: line.amountPence, matchedAt: new Date().toISOString(), matchedBy };
}

export function bankBalanceThrough(entries: JournalEntry[], through: string) {
  return bankEntries(entries).filter((entry) => entry.date <= through).reduce((sum, entry) => sum + entry.amountPence, 0);
}
