import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccount, createJournal, defaultAccounts, ledgerReport } from '../src/aws/shared/accounting.js';

test('balanced journals produce a balanced trial balance and accounting equation', () => {
  const opening = createJournal({ date: '2026-10-03', description: 'Owner funds bank', reference: 'OPEN', lines: [
    { accountId: '1000', debitPence: 10000, creditPence: 0 },
    { accountId: '3000', debitPence: 0, creditPence: 10000 },
  ] }, defaultAccounts, 'terryreedbfv@outlook.com');
  const sale = createJournal({ date: '2026-10-03', description: 'Credit sale', lines: [
    { accountId: '1100', debitPence: 12000, creditPence: 0 },
    { accountId: '4000', debitPence: 0, creditPence: 10000 },
    { accountId: '2100', debitPence: 0, creditPence: 2000 },
  ] }, defaultAccounts, 'terryreedbfv@outlook.com');
  const report = ledgerReport(defaultAccounts, [opening, sale]);
  assert.equal(report.assetsPence, 22000);
  assert.equal(report.liabilitiesPence, 2000);
  assert.equal(report.profitPence, 10000);
  assert.equal(report.assetsPence, report.liabilitiesPence + report.equityPence);
  assert.equal(report.balances.reduce((sum, account) => sum + account.balancePence, 0), 0);
});

test('posting rejects unbalanced, negative and unknown-account lines', () => {
  const base = { date: '2026-10-03', description: 'Invalid journal', lines: [
    { accountId: '1000', debitPence: 100, creditPence: 0 },
    { accountId: '3000', debitPence: 0, creditPence: 99 },
  ] };
  assert.throws(() => createJournal(base, defaultAccounts, 'owner@example.com'), /balance/);
  assert.throws(() => createJournal({ ...base, lines: [{ accountId: '1000', debitPence: -100, creditPence: 0 }, base.lines[1]] }, defaultAccounts, 'owner@example.com'), /valid account/);
  assert.throws(() => createJournal({ ...base, lines: [{ accountId: 'missing', debitPence: 100, creditPence: 0 }, { accountId: '3000', debitPence: 0, creditPence: 100 }] }, defaultAccounts, 'owner@example.com'), /valid account/);
});

test('custom account codes are unique', () => {
  assert.throws(() => createAccount({ code: '1000', name: 'Second bank', type: 'asset' }, defaultAccounts), /already exists/);
  assert.equal(createAccount({ code: '6100', name: 'Office costs', type: 'expense' }, defaultAccounts).code, '6100');
});
