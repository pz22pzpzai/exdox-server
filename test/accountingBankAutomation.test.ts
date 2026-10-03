import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccount, createDocument, createPayment, defaultAccounts, paymentJournal } from '../src/aws/shared/accounting.js';
import { createBankRule, createBankTransfer, matchingBankRules, ruleJournal } from '../src/aws/shared/accountingBankAutomation.js';
import { bankEntries, createBankMatch, createBankStatement, duplicateStatementLines, suggestBankMatches, validateStatementSequence } from '../src/aws/shared/accountingReconciliation.js';

const owner = 'terryreedbfv@outlook.com';
const secondBank = createAccount({ code: '1010', name: 'Savings', type: 'asset', bank: true }, defaultAccounts);
const chart = [...defaultAccounts, secondBank];

test('statements and matches are bound to their bank account', () => {
  const statement = createBankStatement({ accountId: secondBank.id, name: 'Savings October', openingPence: 0, closingPence: 500, lines: [{ date: '2026-10-03', description: 'Savings interest', reference: 'INT-1', amountPence: 500 }] }, owner);
  const transfer = createBankTransfer({ fromAccountId: '1000', toAccountId: secondBank.id, date: '2026-10-03', amountPence: 500, requestId: '11111111-1111-4111-8111-111111111111' }, chart, owner);
  const movements = bankEntries([transfer], ['1000', secondBank.id]);
  assert.equal(movements.length, 2);
  assert.equal(movements.reduce((sum, item) => sum + item.amountPence, 0), 0);
  assert.throws(() => createBankMatch({ statementId: statement.id, lineIndex: 0, bankEntryId: movements.find((item) => item.accountId === '1000')!.id }, [statement], movements, [], owner), /bank account and amount/);
  assert.equal(createBankMatch({ statementId: statement.id, lineIndex: 0, bankEntryId: movements.find((item) => item.accountId === secondBank.id)!.id }, [statement], movements, [], owner).amountPence, 500);
  assert.equal(createBankTransfer({ fromAccountId: '1000', toAccountId: secondBank.id, date: '2026-10-03', amountPence: 500, requestId: '11111111-1111-4111-8111-111111111111' }, chart, owner).id, transfer.id);
});

test('imports flag overlaps and suggest only exact amount and account matches', () => {
  const first = createBankStatement({ name: 'October', openingPence: 0, closingPence: 1200, lines: [{ date: '2026-10-03', description: 'Client A', reference: 'REF-1', amountPence: 1200 }] }, owner);
  const overlap = createBankStatement({ name: 'October second export', openingPence: 1200, closingPence: 2400, lines: [{ date: '2026-10-03', description: 'Client A', reference: 'REF-1', amountPence: 1200 }] }, owner);
  assert.deepEqual(duplicateStatementLines(overlap, [first]), [0]);
  assert.throws(() => validateStatementSequence(overlap, [first]), /overlaps/);
  const next = createBankStatement({ name: 'November', openingPence: 1200, closingPence: 1300, lines: [{ date: '2026-11-03', description: 'Interest', amountPence: 100 }] }, owner);
  assert.doesNotThrow(() => validateStatementSequence(next, [first]));
  assert.throws(() => validateStatementSequence(createBankStatement({ name: 'Wrong opening', openingPence: 0, closingPence: 100, lines: [{ date: '2026-11-04', description: 'Interest', amountPence: 100 }] }, owner), [first]), /Opening balance/);
  const entry = { id: 'j1', date: '2026-10-03', reference: 'REF-1', description: 'Client A', lines: [{ accountId: '1000', debitPence: 1200, creditPence: 0 }], createdAt: '', createdBy: owner };
  const suggestions = suggestBankMatches(first, bankEntries([entry]), []);
  assert.equal(suggestions[0].bankEntryId, 'j1:0');
  assert.equal(suggestions[0].score, 170);
  assert.deepEqual(suggestBankMatches(first, bankEntries([entry]), [createBankMatch({ statementId: first.id, lineIndex: 0, bankEntryId: 'j1:0' }, [first], bankEntries([entry]), [], owner)]), []);
});

test('bank rules post balanced reviewed entries and never use receivable or VAT controls', () => {
  const statement = createBankStatement({ name: 'Bank', openingPence: 0, closingPence: -150, lines: [{ date: '2026-10-03', description: 'Monthly bank fee', amountPence: -150 }] }, owner);
  const rule = createBankRule({ accountId: '1000', contains: 'bank fee', direction: 'out', counterAccountId: '6000' }, chart, owner);
  assert.equal(matchingBankRules(statement, statement.lines[0], [rule]).length, 1);
  const journal = ruleJournal(statement, statement.lines[0], rule, owner);
  assert.equal(journal.lines.reduce((sum, line) => sum + line.debitPence - line.creditPence, 0), 0);
  assert.equal(bankEntries([journal])[0].amountPence, -150);
  assert.throws(() => createBankRule({ accountId: '1000', contains: 'client', direction: 'in', counterAccountId: '1100' }, chart, owner), /non-control/);
  assert.throws(() => createAccount({ code: '1011', name: 'Not a bank', type: 'liability', bank: true }, chart), /asset/);
});

test('invoice receipts can use a second bank account with a stable retry ID', () => {
  const invoice = createDocument({ kind: 'invoice', number: 'INV-2', contactName: 'Client A', issuerName: 'Exdox', issuerAddress: 'London', contactAddress: 'Bristol', date: '2026-10-01', dueDate: '2026-10-31', items: [{ description: 'Service', quantity: 1, unitPricePence: 1000, vatRate: 0, vatCode: 'S0' }] }, owner);
  const payment = createPayment({ date: '2026-10-03', amountPence: 1000, bankAccountId: secondBank.id, requestId: '22222222-2222-4222-8222-222222222222' }, invoice, [], owner);
  assert.equal(payment.id, '22222222-2222-4222-8222-222222222222');
  assert.equal(bankEntries([paymentJournal(payment, invoice)], ['1000', secondBank.id])[0].accountId, secondBank.id);
});
