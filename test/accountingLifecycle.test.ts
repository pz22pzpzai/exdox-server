import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocument, createPayment, documentJournal, paymentJournal } from '../src/aws/shared/accounting.js';
import { createCreditNote, creditJournal } from '../src/aws/shared/accountingSafeguards.js';
import { accountingInvoiceText, approveDraft, createContact, createDraft, createRefund, createSettlement, latestVersions, refundJournal, settlementJournal } from '../src/aws/shared/accountingLifecycle.js';
import { buildVatReport } from '../src/aws/shared/accountingVat.js';

const owner = 'terryreedbfv@outlook.com';
const input = { kind: 'invoice', number: 'INV-101', contactName: 'Customer Ltd', issuerName: 'Exdox Ltd', issuerAddress: 'London', contactAddress: 'Manchester', vatNumber: 'GB123', paymentInstructions: 'Bank transfer', date: '2026-10-01', dueDate: '2026-10-31', items: [{ description: 'Service', quantity: 1, unitPricePence: 10000, vatRate: 20, vatCode: 'S20' }] };

test('contacts and draft revisions retain immutable snapshots until approval', () => {
  const contact = createContact({ name: 'Customer Ltd', email: 'billing@example.com', address: 'Manchester', role: 'customer' }, owner);
  const revised = createContact({ ...contact, address: 'Leeds' }, owner, contact);
  assert.deepEqual(latestVersions([contact, revised]), [revised]);
  const draft = createDraft({ ...input, contactId: contact.id }, owner);
  const edited = createDraft({ ...input, number: 'INV-102', contactId: contact.id }, owner, draft);
  assert.deepEqual(latestVersions([draft, edited]), [edited]);
  assert.equal(draft.document.number, 'INV-101');
  const posted = approveDraft(edited, owner);
  assert.equal(posted.id, draft.id);
  assert.equal(posted.draftId, draft.id);
  assert.equal(posted.number, 'INV-102');
});

test('one settlement allocates a single balanced bank movement to multiple invoices', () => {
  const first = createDocument(input, owner);
  const second = createDocument({ ...input, number: 'INV-102' }, owner);
  const settlement = createSettlement({ kind: 'invoice', date: '2026-10-03', reference: 'BANK-1', allocations: [{ documentId: first.id, amountPence: 4000 }, { documentId: second.id, amountPence: 7000 }] }, [first, second], () => 12000, owner);
  const entry = settlementJournal(settlement);
  assert.equal(settlement.totalPence, 11000);
  assert.equal(entry.lines.filter((line) => line.accountId === '1000').length, 1);
  assert.equal(entry.lines.reduce((sum, line) => sum + line.debitPence - line.creditPence, 0), 0);
  assert.throws(() => createSettlement({ kind: 'invoice', date: '2026-10-03', allocations: [{ documentId: first.id, amountPence: 13000 }] }, [first], () => 12000, owner), /unpaid document/);
  const stable = createSettlement({ kind: 'invoice', date: '2026-10-03', requestId: '33333333-3333-4333-8333-333333333333', allocations: [{ documentId: first.id, amountPence: 4000 }] }, [first], () => 12000, owner);
  assert.equal(stable.id, '33333333-3333-4333-8333-333333333333');
});

test('paid invoice can be credited and refunded with opposite bank posting, without a new VAT issue', () => {
  const invoice = createDocument(input, owner);
  const payment = createPayment({ date: '2026-10-02', amountPence: invoice.totalPence }, invoice, [], owner);
  const credit = createCreditNote({ number: 'CN-101', date: '2026-10-03', reason: 'Service cancelled', items: [{ itemIndex: 0, quantity: 1 }] }, invoice, [], [payment], null, owner);
  assert.equal(credit.totalPence, invoice.totalPence);
  const refund = createRefund({ creditId: credit.id, date: '2026-10-04', amountPence: credit.totalPence, reference: 'BANK-REFUND' }, credit.totalPence, owner);
  assert.equal(createRefund({ creditId: credit.id, date: '2026-10-04', amountPence: credit.totalPence, requestId: '44444444-4444-4444-8444-444444444444' }, credit.totalPence, owner).id, '44444444-4444-4444-8444-444444444444');
  const entries = [documentJournal(invoice), paymentJournal(payment, invoice), creditJournal(credit, invoice), refundJournal(refund, true)];
  assert.equal(entries.flatMap((entry) => entry.lines).reduce((sum, line) => sum + line.debitPence - line.creditPence, 0), 0);
  const report = buildVatReport({ fromDate: '2026-10-01', toDate: '2026-10-31', entries, documents: [invoice], creditNotes: [credit], sourcePostings: [], reversals: [], classifications: [] });
  assert.equal(report.ready, true);
  assert.equal(report.boxes.box1, 0);
  assert.match(accountingInvoiceText(invoice), /Total: GBP 120.00/);
});
