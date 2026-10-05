import type Stripe from 'stripe';

export function invoicePaymentIntentMatches(intent: Stripe.PaymentIntent, amountPence: number, orgId: number, documentId: string, savedAccountId: string, connectedAccountId?: string) {
  if (intent.status !== 'succeeded' || intent.currency !== 'gbp' || intent.amount_received !== amountPence || intent.metadata.checkoutPurpose !== 'accounting_invoice' || intent.metadata.exdoxOrganisationId !== String(orgId) || intent.metadata.documentId !== documentId) return false;
  if (connectedAccountId) return connectedAccountId === savedAccountId && !intent.transfer_data?.destination;
  return intent.transfer_data?.destination === savedAccountId && intent.on_behalf_of === savedAccountId;
}
