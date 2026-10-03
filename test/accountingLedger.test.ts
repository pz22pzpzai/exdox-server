import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccount, createDocument, createJournal, createPayment, defaultAccounts, documentJournal, ledgerReport, paymentJournal } from '../src/aws/shared/accounting.js';

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

test('invoice and bill posting and part payments update receivables, payables and bank', () => {
  const invoice = createDocument({ kind: 'invoice', number: 'INV-1', contactName: 'Customer Ltd', issuerName: 'My Business', issuerAddress: '1 High Street', contactAddress: '2 Market Street', vatNumber: 'GB123', date: '2026-10-03', dueDate: '2026-10-17', items: [{ description: 'Work', quantity: 1, unitPricePence: 10000, vatRate: 20, vatCode: 'S20' }] }, 'owner@example.com');
  const bill = createDocument({ kind: 'bill', number: 'B-1', contactName: 'Supplier Ltd', date: '2026-10-03', dueDate: '2026-10-17', items: [{ description: 'Supplies', quantity: 1, unitPricePence: 4000, vatRate: 20, vatCode: 'P20' }] }, 'owner@example.com');
  const receipt = createPayment({ date: '2026-10-04', amountPence: 6000 }, invoice, [], 'owner@example.com');
  const payout = createPayment({ date: '2026-10-04', amountPence: 4800 }, bill, [], 'owner@example.com');
  const report = ledgerReport(defaultAccounts, [documentJournal(invoice), documentJournal(bill), paymentJournal(receipt, invoice), paymentJournal(payout, bill)]);
  assert.equal(report.balances.find((item) => item.code === '1100')?.balancePence, 6000);
  assert.equal(report.balances.find((item) => item.code === '2000')?.balancePence, 0);
  assert.equal(report.balances.find((item) => item.code === '1000')?.balancePence, 1200);
  assert.equal(report.profitPence, 6000);
  assert.throws(() => createPayment({ date: '2026-10-05', amountPence: 7000 }, invoice, [receipt], 'owner@example.com'), /exceeds/);
});
