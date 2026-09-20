import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import Stripe from 'stripe';

import { getOrganisationName } from './db.js';
import { buildExdoxEmailHtml } from './emailHtml.js';
import { awsEnv } from './env.js';
import { getReceiptJsonObject, putReceiptJsonObject } from './s3.js';
import { trialReminderKind, type TrialReminderKind } from './trialReminderPolicy.js';

const ses = new SESv2Client({});

function reminderKey(subscriptionId: string, kind: TrialReminderKind) {
  return `billing-notifications/trial-continuation/${subscriptionId}-${kind}.json`;
}

async function alreadySent(subscriptionId: string, kind: TrialReminderKind) {
  try {
    return Boolean(await getReceiptJsonObject(reminderKey(subscriptionId, kind)));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return false;
    throw error;
  }
}

function hasPaymentMethod(subscription: Stripe.Subscription, customer: Stripe.Customer) {
  return Boolean(subscription.default_payment_method || subscription.default_source
    || customer.invoice_settings.default_payment_method || customer.default_source);
}

export async function sendTrialContinuationReminder(subscription: Stripe.Subscription, stripe: Stripe, now = Date.now()) {
  const kind = trialReminderKind(subscription, now);
  if (!kind || await alreadySent(subscription.id, kind)) return false;

  const organisationId = Number(subscription.metadata.organisationId);
  if (!Number.isSafeInteger(organisationId) || organisationId <= 0) return false;
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) return false;
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted || !customer.email?.trim()) return false;
  if (kind === 'ending' && hasPaymentMethod(subscription, customer)) return false;

  const organisationName = await getOrganisationName(organisationId);
  const trialEnd = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full', timeStyle: 'short', timeZone: 'Europe/London',
  }).format(new Date(subscription.trial_end! * 1000));
  const loginUrl = new URL(awsEnv.confirmEmailLoginUrl);
  loginUrl.searchParams.set('trial', kind);
  const action = { label: kind === 'ending' ? 'Sign in to continue after your trial' : 'Sign in and start your subscription', url: loginUrl.toString() };
  const heading = kind === 'ending' ? 'Your Exdox trial is ending soon' : 'Your Exdox trial has ended';
  const paragraphs = kind === 'ending'
    ? [`Your free trial for ${organisationName} ends on ${trialEnd}. No payment details were required to start it. To keep access, sign in and use Billing to add a payment method. If you do not, access pauses at the end of the trial and you will not be charged.`]
    : [`Your free trial for ${organisationName} ended on ${trialEnd}. Your workspace is paused and you have not been charged for a monthly subscription. Sign in with your existing Exdox account to complete the first monthly payment securely in Stripe. Your monthly billing date starts on that payment date.`];
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    ReplyToAddresses: [awsEnv.inviteEmailFrom],
    Destination: { ToAddresses: [customer.email.trim()] },
    Content: { Simple: {
      Subject: { Data: heading },
      Body: {
        Text: { Data: [heading, '', ...paragraphs, '', `${action.label}: ${action.url}`, '', 'Exdox support: contact@exdox.co.uk'].join('\n') },
        Html: { Data: buildExdoxEmailHtml({ heading, paragraphs, action }) },
      },
    } },
  }));
  await putReceiptJsonObject(reminderKey(subscription.id, kind), {
    version: 1, subscriptionId: subscription.id, organisationId, kind,
    recipient: customer.email.trim(), messageId: response.MessageId ?? null,
    sentAt: new Date(now).toISOString(),
  });
  return true;
}
