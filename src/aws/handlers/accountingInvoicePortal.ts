import { createHash, randomUUID } from 'node:crypto';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import Stripe from 'stripe';
import { dueFor, ledger } from './accounting.js';
import type { AccountingPayment } from '../shared/accounting.js';
import { createAudit } from '../shared/accountingLifecycle.js';
import { currentInvoiceLink, decodeInvoiceToken, ensureInvoiceLink, invoicePdf, invoiceUrl } from '../shared/accountingInvoicePresentation.js';
import { invoicePaymentIntentMatches } from '../shared/accountingInvoicePaymentVerification.js';
import { requireAuthenticatedUser } from '../shared/auth.js';
import { findUserByEmail } from '../shared/db.js';
import { awsEnv } from '../shared/env.js';
import { jsonResponse } from '../shared/http.js';
import { deleteReceiptObject, getReceiptJsonObject, listAllReceiptJsonKeys, putReceiptJsonObject, withReceiptObjectLock } from '../shared/s3.js';

const pilotEmail = 'terryreedbfv@outlook.com';
const stripe = () => {
  if (!awsEnv.stripeSecretKey) throw new Error('Stripe is not configured.');
  return new Stripe(awsEnv.stripeSecretKey, { apiVersion: '2026-06-24.dahlia' });
};
type PaymentConnection = { accountId: string; createdAt: string };
type CheckoutMarker = { requestId: string; sessionId: string; url: string; expiresAt: number; amountPence: number; accountId?: string; chargeMode?: 'direct' | 'destination'; status: 'creating' | 'open' | 'paid' | 'needs_review' };
const connectionKey = (prefix: string) => `${prefix}invoice-payment-connection.json`;
const checkoutKey = (prefix: string, documentId: string) => `${prefix}invoice-checkouts/${documentId}.json`;
const noStore = { 'Cache-Control': 'no-store, private', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
const bad = (message: string, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function errorResponse(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  return jsonResponse(status, { success: false, message: status === 500 ? 'Invoice service is temporarily unavailable.' : error instanceof Error ? error.message : 'Request failed.' });
}
async function optional<T>(key: string): Promise<T | null> {
  try { return await getReceiptJsonObject<T>(key); }
  catch (error) {
    const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (value.name === 'NoSuchKey' || value.name === 'NotFound' || value.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}
async function privateScope(event: APIGatewayProxyEventV2) {
  const user = requireAuthenticatedUser(event);
  const current = await findUserByEmail(pilotEmail);
  if (user.email.trim().toLowerCase() !== pilotEmail || !current || current.id !== user.id || current.organisationId !== user.organisationId || current.status !== 'active') throw bad('Accounting is locked for this account.', 403);
  return { user, prefix: `accounting/org-${user.organisationId}/` };
}
async function publicInvoice(token: string) {
  const parsed = decodeInvoiceToken(token);
  if (!parsed) throw bad('This invoice link is invalid.', 404);
  const user = await findUserByEmail(pilotEmail);
  if (!user || user.status !== 'active' || user.organisationId !== parsed.orgId) throw bad('This invoice link is unavailable.', 404);
  const prefix = `accounting/org-${parsed.orgId}/`;
  const link = await currentInvoiceLink(prefix, parsed.documentId);
  if (!link?.active || link.nonce !== parsed.nonce) throw bad('This invoice link is no longer available.', 404);
  const books = await ledger(prefix);
  const document = books.documents.find((item) => item.id === parsed.documentId && item.kind === 'invoice');
  if (!document) throw bad('This invoice is unavailable.', 404);
  if (books.reversals.some((item) => item.targetEntryId === `document-${document.id}`)) throw bad('This invoice was voided.', 410);
  return { user, prefix, document, books };
}
async function connectedAccount(prefix: string) {
  const saved = await optional<PaymentConnection>(connectionKey(prefix));
  if (!saved || !awsEnv.stripeSecretKey) return null;
  const account = await stripe().accounts.retrieve(saved.accountId);
  const accountReady = account.charges_enabled && account.payouts_enabled;
  const eventsReady = accountReady && await webhookReady().catch(() => false);
  return { saved, accountReady, eventsReady, ready: accountReady && eventsReady };
}
async function webhookReady() {
  if (!awsEnv.stripeConnectWebhookSecret) return false;
  const endpoints = await stripe().webhookEndpoints.list({ limit: 100 });
  return endpoints.data.some((endpoint) => endpoint.livemode && endpoint.status === 'enabled' && endpoint.url === 'https://hz2zkm6jkf.execute-api.eu-west-2.amazonaws.com/prod/accounting/stripe-connect/webhook' && ['checkout.session.completed', 'charge.refunded', 'charge.dispute.created'].every((name) => endpoint.enabled_events.map(String).includes(name) || endpoint.enabled_events.map(String).includes('*')));
}

export async function invoiceLinkHandler(event: APIGatewayProxyEventV2) {
  try {
    const { user, prefix } = await privateScope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const documentId = String(data.documentId ?? '');
    if (!/^[0-9a-f-]{36}$/.test(documentId)) throw bad('Choose a posted invoice.');
    return await withReceiptObjectLock(`${prefix}write-lease.json`, async () => {
      const books = await ledger(prefix);
      if (!books.documents.some((item) => item.id === documentId && item.kind === 'invoice')) throw bad('Choose a posted invoice.');
      if (books.reversals.some((item) => item.targetEntryId === `document-${documentId}`)) throw bad('This invoice was voided.');
      const action = String(data.action ?? 'create');
      if (action === 'revoke') {
        const existing = await currentInvoiceLink(prefix, documentId);
        if (existing?.active) await putReceiptJsonObject(`${prefix}invoice-links/${documentId}.json`, { ...existing, active: false });
        await putReceiptJsonObject(`${prefix}audit/${randomUUID()}.json`, createAudit('invoice.link_revoked', documentId, 'Customer invoice link revoked', user.email));
        return jsonResponse(200, { success: true, url: null });
      }
      if (action !== 'create') throw bad('Invalid link action.');
      const link = await ensureInvoiceLink(prefix, documentId);
      return jsonResponse(200, { success: true, url: invoiceUrl(user.organisationId, link) });
    });
  } catch (error) { return errorResponse(error); }
}

export async function invoicePaymentConnectionHandler(event: APIGatewayProxyEventV2) {
  try {
    const { user, prefix } = await privateScope(event);
    const method = event.requestContext?.http?.method ?? (event as APIGatewayProxyEventV2 & { httpMethod?: string }).httpMethod;
    if (method === 'GET') {
      const account = await connectedAccount(prefix);
      return jsonResponse(200, { success: true, configured: Boolean(awsEnv.stripeSecretKey), connected: Boolean(account), accountReady: Boolean(account?.accountReady), eventsReady: Boolean(account?.eventsReady), ready: Boolean(account?.ready) });
    }
    const api = stripe();
    const saved = await withReceiptObjectLock(`${prefix}write-lease.json`, async () => {
      const existing = await optional<PaymentConnection>(connectionKey(prefix));
      if (existing) return existing;
      const account = await api.accounts.create({ type: 'standard', country: 'GB', email: user.email, metadata: { exdoxOrganisationId: String(user.organisationId) } }, { idempotencyKey: `exdox-accounting-connect-${user.organisationId}` });
      const created = { accountId: account.id, createdAt: new Date().toISOString() };
      await putReceiptJsonObject(connectionKey(prefix), created);
      return created;
    });
    const link = await api.accountLinks.create({ account: saved.accountId, type: 'account_onboarding', refresh_url: 'https://exdox.co.uk/accounting?stripe_connect=refresh', return_url: 'https://exdox.co.uk/accounting?stripe_connect=return' });
    return jsonResponse(200, { success: true, url: link.url });
  } catch (error) { return errorResponse(error); }
}

export async function invoicePaymentReviewHandler(event: APIGatewayProxyEventV2) {
  try {
    const { user, prefix } = await privateScope(event);
    const data = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const documentId = String(data.documentId ?? '');
    const resolution = String(data.resolution ?? '').trim();
    if (!/^[0-9a-f-]{36}$/.test(documentId) || data.confirm !== true || resolution.length < 15 || resolution.length > 500) throw bad('Choose the invoice and enter how you reconciled or refunded the payment (15–500 characters).');
    return await withReceiptObjectLock(`${prefix}write-lease.json`, async () => {
      const holdKey = `${prefix}invoice-payment-holds/${documentId}.json`;
      if (!await optional(holdKey)) throw bad('This invoice has no payment hold.');
      const keys = await listAllReceiptJsonKeys(`${prefix}invoice-payment-exceptions/`);
      let count = 0;
      for (const key of keys.filter((item) => item.endsWith('.json'))) {
        const record = await getReceiptJsonObject<{ documentId: string; resolvedAt?: string; [key: string]: unknown }>(key);
        if (record.documentId !== documentId || record.resolvedAt) continue;
        await putReceiptJsonObject(key, { ...record, resolvedAt: new Date().toISOString(), resolvedBy: user.email, resolution });
        count += 1;
      }
      if (!count) throw bad('No unresolved payment review was found.');
      await deleteReceiptObject(holdKey);
      await putReceiptJsonObject(`${prefix}audit/${randomUUID()}.json`, createAudit('invoice.payment_review_resolved', documentId, resolution, user.email));
      return jsonResponse(200, { success: true, resolved: count });
    });
  } catch (error) { return errorResponse(error); }
}

export async function publicInvoiceHandler(event: APIGatewayProxyEventV2) {
  try {
    const token = String(event.pathParameters?.token ?? '');
    const { prefix, document, books } = await publicInvoice(token);
    const requestPath = event.rawPath ?? (event as APIGatewayProxyEventV2 & { path?: string }).path ?? '';
    if (requestPath.endsWith('/pdf')) {
      const pdf = await invoicePdf(document);
      return { statusCode: 200, isBase64Encoded: true, headers: { ...noStore, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="invoice-${document.number.replace(/[^A-Za-z0-9-]/g, '-')}.pdf"`, 'Access-Control-Allow-Origin': '*' }, body: Buffer.from(pdf).toString('base64') };
    }
    const connection = await connectedAccount(prefix).catch(() => null);
    const hold = await optional<{ reason: string }>(`${prefix}invoice-payment-holds/${document.id}.json`);
    const outstandingPence = Math.max(0, dueFor(document, books));
    const { number, contactName, issuerName, issuerAddress, contactAddress, vatNumber, paymentInstructions, date, taxDate, dueDate, items, netPence, vatPence, totalPence } = document;
    return { ...jsonResponse(200, { success: true, document: { number, contactName, issuerName, issuerAddress, contactAddress, vatNumber, paymentInstructions, date, taxDate, dueDate, items, netPence, vatPence, totalPence }, outstandingPence, canPay: outstandingPence > 0 && Boolean(connection?.ready) && !hold && !books.reversals.some((item) => item.targetEntryId === `document-${document.id}`) }), headers: { ...jsonResponse(200, {}).headers, ...noStore } };
  } catch (error) { return { ...errorResponse(error), headers: { ...errorResponse(error).headers, ...noStore } }; }
}

export async function publicInvoiceCheckoutHandler(event: APIGatewayProxyEventV2) {
  try {
    const token = String(event.pathParameters?.token ?? '');
    const initial = await publicInvoice(token);
    return await withReceiptObjectLock(`${initial.prefix}write-lease.json`, async () => {
      const { user, prefix, document, books } = await publicInvoice(token);
      const amountPence = dueFor(document, books);
      if (amountPence <= 0 || books.reversals.some((item) => item.targetEntryId === `document-${document.id}`)) throw bad('This invoice has no payment due.');
      if (await optional(`${prefix}invoice-payment-holds/${document.id}.json`)) throw bad('This invoice payment needs review before another online payment.', 409);
      const connected = await connectedAccount(prefix);
      if (!connected?.ready) throw bad('Online payment is not enabled for this business.', 409);
      const existing = await optional<CheckoutMarker>(checkoutKey(prefix, document.id));
      if (existing?.status === 'open' && existing.chargeMode === 'direct' && existing.accountId === connected.saved.accountId && existing.expiresAt > Date.now() / 1000 + 30 && existing.amountPence === amountPence) return jsonResponse(200, { success: true, url: existing.url });
      const requestId = existing?.status === 'creating' && existing.chargeMode === 'direct' && existing.accountId === connected.saved.accountId && existing.amountPence === amountPence && existing.expiresAt > Date.now() / 1000 ? existing.requestId : randomUUID();
      const expiresAt = existing?.status === 'creating' && requestId === existing.requestId ? existing.expiresAt : Math.floor(Date.now() / 1000) + 1800;
      await putReceiptJsonObject(checkoutKey(prefix, document.id), { requestId, sessionId: '', url: '', expiresAt, amountPence, accountId: connected.saved.accountId, chargeMode: 'direct', status: 'creating' } satisfies CheckoutMarker);
      const session = await stripe().checkout.sessions.create({
        mode: 'payment', payment_method_types: ['card'],
        line_items: [{ price_data: { currency: 'gbp', unit_amount: amountPence, product_data: { name: `Invoice ${document.number} from ${document.issuerName}` } }, quantity: 1 }],
        payment_intent_data: { metadata: { checkoutPurpose: 'accounting_invoice', exdoxOrganisationId: String(user.organisationId), documentId: document.id } },
        metadata: { checkoutPurpose: 'accounting_invoice', exdoxOrganisationId: String(user.organisationId), documentId: document.id },
        success_url: `https://exdox.co.uk/invoice/${token}?payment=success`, cancel_url: `https://exdox.co.uk/invoice/${token}?payment=cancelled`,
        expires_at: expiresAt,
      }, { stripeAccount: connected.saved.accountId, idempotencyKey: `invoice-checkout-${requestId}` });
      if (!session.url) throw new Error('Stripe did not return a checkout URL.');
      await putReceiptJsonObject(checkoutKey(prefix, document.id), { requestId, sessionId: session.id, url: session.url, expiresAt: session.expires_at ?? 0, amountPence, accountId: connected.saved.accountId, chargeMode: 'direct', status: 'open' } satisfies CheckoutMarker);
      return jsonResponse(200, { success: true, url: session.url });
    });
  } catch (error) { return errorResponse(error); }
}

function paymentId(sessionId: string) {
  const hash = createHash('sha256').update(`accounting-payment:${sessionId}`).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}
export async function fulfillAccountingInvoiceCheckout(session: Stripe.Checkout.Session, api: Stripe, connectedAccountId?: string) {
  if (session.metadata?.checkoutPurpose !== 'accounting_invoice') return false;
  if (session.payment_status !== 'paid' || session.currency !== 'gbp' || !Number.isSafeInteger(session.amount_total) || !session.amount_total || session.amount_total <= 0) return true;
  const orgId = Number(session.metadata.exdoxOrganisationId);
  const documentId = session.metadata.documentId;
  if (!Number.isSafeInteger(orgId) || orgId <= 0 || !documentId || !/^[0-9a-f-]{36}$/.test(documentId)) throw new Error('Invalid accounting invoice payment metadata.');
  const user = await findUserByEmail(pilotEmail);
  if (!user || user.status !== 'active' || user.organisationId !== orgId) throw new Error('Accounting invoice owner is unavailable.');
  const prefix = `accounting/org-${orgId}/`;
  const connection = await optional<PaymentConnection>(connectionKey(prefix));
  const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  if (!connection || !intentId || (connectedAccountId && connection.accountId !== connectedAccountId)) throw new Error('Invoice payment account is missing or mismatched.');
  const intent = await api.paymentIntents.retrieve(intentId, undefined, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined);
  if (!invoicePaymentIntentMatches(intent, session.amount_total, orgId, documentId, connection.accountId, connectedAccountId)) throw new Error('Invoice payment account or amount did not verify.');
  await withReceiptObjectLock(`${prefix}write-lease.json`, async () => {
    const key = `${prefix}payments/${paymentId(session.id)}.json`;
    if (await optional<AccountingPayment>(key)) return;
    const books = await ledger(prefix);
    const document = books.documents.find((item) => item.id === documentId && item.kind === 'invoice');
    if (!document) throw new Error('Paid invoice is missing.');
    const due = dueFor(document, books);
    if (due < session.amount_total!) {
      await putReceiptJsonObject(`${prefix}invoice-payment-exceptions/${session.id}.json`, { documentId, sessionId: session.id, receivedPence: session.amount_total, duePence: due, at: new Date().toISOString(), reason: 'Payment exceeds current balance; review and refund or allocate manually.' });
      await putReceiptJsonObject(`${prefix}invoice-payment-holds/${documentId}.json`, { reason: 'Payment exceeds current balance', at: new Date().toISOString() });
      const marker = await optional<CheckoutMarker>(checkoutKey(prefix, documentId));
      if (marker?.sessionId === session.id) await putReceiptJsonObject(checkoutKey(prefix, documentId), { ...marker, status: 'needs_review' });
      return;
    }
    const date = new Date().toISOString().slice(0, 10);
    const payment: AccountingPayment = { id: paymentId(session.id), documentId, bankAccountId: '1050', date, amountPence: session.amount_total!, reference: `Stripe ${session.id}`.slice(0, 80), createdAt: new Date().toISOString(), createdBy: 'Stripe invoice checkout' };
    await putReceiptJsonObject(key, payment);
    await putReceiptJsonObject(`${prefix}audit/${randomUUID()}.json`, createAudit('invoice.payment_received', documentId, `${document.number}: GBP ${(payment.amountPence / 100).toFixed(2)} via Stripe Checkout ${session.id}`, 'Stripe invoice checkout'));
    const marker = await optional<CheckoutMarker>(checkoutKey(prefix, documentId));
    if (marker?.sessionId === session.id) await putReceiptJsonObject(checkoutKey(prefix, documentId), { ...marker, status: 'paid' });
  });
  return true;
}

export async function flagAccountingInvoiceCharge(charge: Stripe.Charge, reason: 'refund' | 'dispute', api: Stripe, connectedAccountId?: string) {
  const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
  if (!intentId) return false;
  const intent = await api.paymentIntents.retrieve(intentId, undefined, connectedAccountId ? { stripeAccount: connectedAccountId } : undefined);
  if (intent.metadata.checkoutPurpose !== 'accounting_invoice') return false;
  const orgId = Number(intent.metadata.exdoxOrganisationId);
  const documentId = intent.metadata.documentId;
  const user = await findUserByEmail(pilotEmail);
  if (!user || user.status !== 'active' || user.organisationId !== orgId || !documentId || !/^[0-9a-f-]{36}$/.test(documentId)) throw new Error('Invoice payment review could not identify the owner.');
  const prefix = `accounting/org-${orgId}/`;
  if (connectedAccountId && (await optional<PaymentConnection>(connectionKey(prefix)))?.accountId !== connectedAccountId) throw new Error('Invoice refund or dispute account did not match.');
  await withReceiptObjectLock(`${prefix}write-lease.json`, async () => {
    const books = await ledger(prefix);
    const document = books.documents.find((item) => item.id === documentId);
    const duePence = document ? dueFor(document, books) : 0;
    const description = reason === 'refund' ? 'Stripe refund requires accounting review.' : 'Stripe dispute requires accounting review.';
    await putReceiptJsonObject(`${prefix}invoice-payment-exceptions/${charge.id}-${reason}.json`, { documentId, sessionId: charge.id, receivedPence: reason === 'refund' ? charge.amount_refunded : charge.amount, duePence, at: new Date().toISOString(), reason: description });
    await putReceiptJsonObject(`${prefix}invoice-payment-holds/${documentId}.json`, { reason: description, at: new Date().toISOString() });
  });
  return true;
}
