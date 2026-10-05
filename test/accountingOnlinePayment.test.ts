import assert from 'node:assert/strict';
import test from 'node:test';
import type Stripe from 'stripe';
import { createDocument, defaultAccounts, paymentJournal, type AccountingPayment } from '../src/aws/shared/accounting.js';
import { invoicePaymentIntentMatches } from '../src/aws/shared/accountingInvoicePaymentVerification.js';

test('online invoice receipts clear receivables into Stripe clearing, not the bank', () => {
  const clearing = defaultAccounts.find((account) => account.id === '1050');
  assert.deepEqual({ type: clearing?.type, bank: clearing?.bank }, { type: 'asset', bank: undefined });
  const invoice = createDocument({ kind: 'invoice', number: 'INV-1', contactName: 'Customer Ltd', issuerName: 'Example Ltd', issuerAddress: '1 Main Street', contactAddress: '2 Main Street', date: '2026-10-04', dueDate: '2026-10-18', vatNumber: '', paymentInstructions: '', items: [{ description: 'Service', quantity: 1, unitPricePence: 10000, vatRate: 0, vatCode: 'S0' }] }, 'owner');
  const payment: AccountingPayment = { id: 'checkout-payment', documentId: invoice.id, bankAccountId: '1050', date: '2026-10-04', amountPence: 10000, reference: 'Stripe session', createdAt: '2026-10-04T12:00:00Z', createdBy: 'Stripe invoice checkout' };
  assert.deepEqual(paymentJournal(payment, invoice).lines, [
    { accountId: '1050', debitPence: 10000, creditPence: 0 },
    { accountId: '1100', debitPence: 0, creditPence: 10000 },
  ]);
});

test('a direct invoice charge must belong to the connected business and match the full payment', () => {
  const intent = { status: 'succeeded', currency: 'gbp', amount_received: 10000, metadata: { checkoutPurpose: 'accounting_invoice', exdoxOrganisationId: '42', documentId: 'invoice-1' }, transfer_data: null } as unknown as Stripe.PaymentIntent;
  assert.equal(invoicePaymentIntentMatches(intent, 10000, 42, 'invoice-1', 'acct_business', 'acct_business'), true);
  assert.equal(invoicePaymentIntentMatches(intent, 10000, 42, 'invoice-1', 'acct_business', 'acct_other'), false);
  assert.equal(invoicePaymentIntentMatches(intent, 9900, 42, 'invoice-1', 'acct_business', 'acct_business'), false);
  assert.equal(invoicePaymentIntentMatches(intent, 10000, 42, 'invoice-other', 'acct_business', 'acct_business'), false);
  assert.equal(invoicePaymentIntentMatches({ ...intent, transfer_data: { destination: 'acct_other' } } as Stripe.PaymentIntent, 10000, 42, 'invoice-1', 'acct_business', 'acct_business'), false);
});
