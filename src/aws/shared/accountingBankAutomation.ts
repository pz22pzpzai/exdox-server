import { randomUUID } from 'node:crypto';
import type { JournalEntry, LedgerAccount } from './accounting.js';
import { validBookDate } from './accountingSafeguards.js';
import type { BankStatement, StatementLine } from './accountingReconciliation.js';

export type BankRule = { id: string; version: number; accountId: string; contains: string; direction: 'in' | 'out' | 'both'; counterAccountId: string; enabled: boolean; createdAt: string; createdBy: string };
export function createBankRule(input: unknown, accounts: LedgerAccount[], by: string, prior?: BankRule): BankRule {
  const data = input as Record<string, unknown>;
  const accountId = String(data.accountId ?? '1000');
  const counterAccountId = String(data.counterAccountId ?? '');
  const contains = String(data.contains ?? '').trim().toLowerCase();
  const direction = String(data.direction ?? 'both');
  if (!accounts.some((item) => item.id === accountId && item.bank) || !accounts.some((item) => item.id === counterAccountId && !item.bank && !['1100', '1200', '2000', '2100'].includes(item.id)) || contains.length < 3 || contains.length > 100 || !['in', 'out', 'both'].includes(direction)) throw new Error('Choose a bank account, a non-control counter account, a match phrase of 3–100 characters, and a direction.');
  return { id: prior?.id ?? randomUUID(), version: (prior?.version ?? 0) + 1, accountId, counterAccountId, contains, direction: direction as BankRule['direction'], enabled: data.enabled !== false, createdAt: new Date().toISOString(), createdBy: by };
}
export function matchingBankRules(statement: BankStatement, line: StatementLine, rules: BankRule[]) {
  const phrase = `${line.description} ${line.reference}`.toLowerCase();
  return rules.filter((rule) => rule.enabled && rule.accountId === (statement.accountId ?? '1000') && phrase.includes(rule.contains) && (rule.direction === 'both' || rule.direction === (line.amountPence > 0 ? 'in' : 'out'))).sort((a, b) => b.contains.length - a.contains.length || a.id.localeCompare(b.id));
}
export function ruleJournal(statement: BankStatement, line: StatementLine, rule: BankRule, by: string): JournalEntry {
  const amountPence = Math.abs(line.amountPence);
  return { id: `bankrule-${statement.id}-${line.index}`, date: line.date, reference: line.reference || statement.name, description: line.description, lines: line.amountPence > 0 ? [
    { accountId: rule.accountId, debitPence: amountPence, creditPence: 0 }, { accountId: rule.counterAccountId, debitPence: 0, creditPence: amountPence },
  ] : [{ accountId: rule.counterAccountId, debitPence: amountPence, creditPence: 0 }, { accountId: rule.accountId, debitPence: 0, creditPence: amountPence }], createdAt: new Date().toISOString(), createdBy: by };
}
export function createBankTransfer(input: unknown, accounts: LedgerAccount[], by: string): JournalEntry {
  const data = input as Record<string, unknown>;
  const fromAccountId = String(data.fromAccountId ?? '');
  const toAccountId = String(data.toAccountId ?? '');
  const date = String(data.date ?? '');
  const amountPence = Number(data.amountPence);
  const reference = String(data.reference ?? '').trim();
  const requestId = String(data.requestId ?? '');
  if (requestId && !/^[0-9a-f-]{36}$/.test(requestId)) throw new Error('Invalid transfer request ID.');
  if (!accounts.some((item) => item.id === fromAccountId && item.bank) || !accounts.some((item) => item.id === toAccountId && item.bank) || fromAccountId === toAccountId || !validBookDate(date) || !Number.isSafeInteger(amountPence) || amountPence <= 0 || reference.length > 80) throw new Error('Choose two different bank accounts, a valid date, and a positive transfer amount.');
  return { id: requestId ? `transfer-${requestId}` : randomUUID(), date, reference, description: `Transfer between bank accounts`, lines: [{ accountId: toAccountId, debitPence: amountPence, creditPence: 0 }, { accountId: fromAccountId, debitPence: 0, creditPence: amountPence }], createdAt: new Date().toISOString(), createdBy: by };
}
