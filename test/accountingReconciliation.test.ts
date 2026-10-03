import assert from 'node:assert/strict';
import test from 'node:test';
import { createJournal, defaultAccounts } from '../src/aws/shared/accounting.js';
import { bankBalanceThrough, bankEntries, createBankMatch, createBankStatement } from '../src/aws/shared/accountingReconciliation.js';

test('statement import requires opening plus movements to equal closing', () => {
  const input = { name: 'October bank', openingPence: 1000, closingPence: 1300, lines: [
    { date: '2026-10-02', description: 'Customer payment', amountPence: 500 },
    { date: '2026-10-03', description: 'Bank fee', amountPence: -200 },
  ] };
  const statement = createBankStatement(input, 'terryreedbfv@outlook.com');
  assert.equal(statement.lines.length, 2);
  assert.equal(statement.fromDate, '2026-10-02');
  assert.equal(statement.toDate, '2026-10-03');
  assert.equal(createBankStatement(input, 'terryreedbfv@outlook.com').id, statement.id);
  assert.throws(() => createBankStatement({ ...input, closingPence: 1301 }, 'owner'), /Opening balance/);
});

test('matching requires the same signed bank amount and is one-to-one', () => {
  const statement = createBankStatement({ name: 'October bank', openingPence: 0, closingPence: 500, lines: [{ date: '2026-10-02', description: 'Deposit', amountPence: 500 }] }, 'owner');
  const deposit = createJournal({ date: '2026-10-02', description: 'Deposit posted', lines: [
    { accountId: '1000', debitPence: 500, creditPence: 0 },
    { accountId: '3000', debitPence: 0, creditPence: 500 },
  ] }, defaultAccounts, 'owner');
  const withdrawal = createJournal({ date: '2026-10-02', description: 'Withdrawal posted', lines: [
    { accountId: '6000', debitPence: 500, creditPence: 0 },
    { accountId: '1000', debitPence: 0, creditPence: 500 },
  ] }, defaultAccounts, 'owner');
  const entries = bankEntries([deposit, withdrawal]);
  const match = createBankMatch({ statementId: statement.id, lineIndex: 0, bankEntryId: entries[0].id }, [statement], entries, [], 'owner');
  assert.equal(match.amountPence, 500);
  assert.throws(() => createBankMatch({ statementId: statement.id, lineIndex: 0, bankEntryId: entries[1].id }, [statement], entries, [], 'owner'), /exactly/);
  assert.throws(() => createBankMatch({ statementId: statement.id, lineIndex: 0, bankEntryId: entries[0].id }, [statement], entries, [match], 'owner'), /already matched/);
  assert.equal(bankBalanceThrough([deposit, withdrawal], '2026-10-02'), 0);
  assert.equal(bankBalanceThrough([deposit, withdrawal], '2026-10-01'), 0);
});
