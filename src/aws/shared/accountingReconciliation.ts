import { createHash } from 'node:crypto';
import type { JournalEntry } from './accounting.js';

export type StatementLine = { index: number; date: string; description: string; reference: string; amountPence: number };
export type BankStatement = { id: string; accountId?: string; name: string; openingPence: number; closingPence: number; fromDate: string; toDate: string; lines: StatementLine[]; importedAt: string; importedBy: string };
export type BankMatch = { statementId: string; lineIndex: number; bankEntryId: string; amountPence: number; matchedAt: string; matchedBy: string };
export type BankEntry = { id: string; accountId: string; date: string; reference: string; description: string; amountPence: number };
export type MatchSuggestion = { statementId: string; lineIndex: number; bankEntryId: string; score: number; reason: string };

function validDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function createBankStatement(input: unknown, importedBy: string): BankStatement {
  const data = input as Record<string, unknown>;
  const name = String(data?.name ?? '').trim();
  const accountId = String(data?.accountId ?? '1000');
  if (!/^(1000|[0-9a-f-]{36})$/.test(accountId)) throw new Error('Choose a valid bank account.');
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
  const hash = createHash('sha256').update(JSON.stringify({ accountId, openingPence, closingPence, lines })).digest('hex');
  return { id: hash, accountId, name, openingPence, closingPence, fromDate: dates[0], toDate: dates[dates.length - 1], lines, importedAt: new Date().toISOString(), importedBy };
}

export function bankEntries(entries: JournalEntry[], accountIds: string[] = ['1000']): BankEntry[] {
  const allowed = new Set(accountIds);
  return entries.flatMap((entry) => entry.lines.flatMap((line, index) => allowed.has(line.accountId) ? [{
    id: `${entry.id}:${index}`,
    accountId: line.accountId,
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
  if (line.amountPence !== bankEntry.amountPence || (statement?.accountId ?? '1000') !== bankEntry.accountId) throw new Error('Statement and ledger bank account and amount must match exactly.');
  if (existing.some((match) => match.statementId === statementId && match.lineIndex === lineIndex)) throw new Error('That statement line is already matched.');
  if (existing.some((match) => match.bankEntryId === bankEntryId)) throw new Error('That ledger transaction is already matched.');
  return { statementId, lineIndex, bankEntryId, amountPence: line.amountPence, matchedAt: new Date().toISOString(), matchedBy };
}

export function bankBalanceThrough(entries: JournalEntry[], through: string, accountId = '1000') {
  return bankEntries(entries, [accountId]).filter((entry) => entry.date <= through).reduce((sum, entry) => sum + entry.amountPence, 0);
}

const normal = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function duplicateStatementLines(candidate: BankStatement, existing: BankStatement[]) {
  const prior = existing.filter((item) => (item.accountId ?? '1000') === (candidate.accountId ?? '1000'));
  const exact = new Set(prior.flatMap((item) => item.lines.map((line) => `${line.date}|${line.amountPence}|${normal(line.reference)}|${normal(line.description)}`)));
  return candidate.lines.filter((line) => exact.has(`${line.date}|${line.amountPence}|${normal(line.reference)}|${normal(line.description)}`)).map((line) => line.index);
}
export function validateStatementSequence(candidate: BankStatement, existing: BankStatement[]) {
  const sameBank = existing.filter((item) => (item.accountId ?? '1000') === (candidate.accountId ?? '1000'));
  if (sameBank.some((item) => candidate.fromDate <= item.toDate && candidate.toDate >= item.fromDate)) throw new Error('This statement date range overlaps an imported statement for the same bank account. Import a non-overlapping export.');
  const previous = sameBank.filter((item) => item.toDate < candidate.fromDate).sort((a, b) => b.toDate.localeCompare(a.toDate))[0];
  if (previous && previous.closingPence !== candidate.openingPence) throw new Error('Opening balance must equal the previous statement closing balance for this bank account.');
  const next = sameBank.filter((item) => item.fromDate > candidate.toDate).sort((a, b) => a.fromDate.localeCompare(b.fromDate))[0];
  if (next && next.openingPence !== candidate.closingPence) throw new Error('Closing balance must equal the next imported statement opening balance for this bank account.');
}
export function suggestBankMatches(statement: BankStatement, entries: BankEntry[], matches: BankMatch[]): MatchSuggestion[] {
  const usedLines = new Set(matches.filter((item) => item.statementId === statement.id).map((item) => item.lineIndex));
  const usedEntries = new Set(matches.map((item) => item.bankEntryId));
  return statement.lines.filter((line) => !usedLines.has(line.index)).flatMap((line) => {
    const candidates = entries.filter((entry) => entry.accountId === (statement.accountId ?? '1000') && entry.amountPence === line.amountPence && !usedEntries.has(entry.id)).map((entry) => {
      const days = Math.abs((Date.parse(`${line.date}T00:00:00Z`) - Date.parse(`${entry.date}T00:00:00Z`)) / 86400000);
      const ref = Boolean(normal(line.reference) && normal(line.reference) === normal(entry.reference));
      const description = Boolean(normal(line.description) && (normal(entry.description).includes(normal(line.description)) || normal(line.description).includes(normal(entry.description))));
      return { statementId: statement.id, lineIndex: line.index, bankEntryId: entry.id, score: Math.max(0, 100 - days * 5) + (ref ? 50 : 0) + (description ? 20 : 0), reason: `${ref ? 'Reference matches; ' : ''}${description ? 'description resembles; ' : ''}${days} day(s) apart` };
    }).filter((candidate) => candidate.score >= 60).sort((a, b) => b.score - a.score);
    return candidates.length ? [candidates[0]] : [];
  });
}
