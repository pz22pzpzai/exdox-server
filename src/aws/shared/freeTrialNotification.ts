import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import Stripe from 'stripe';

import { getPlanDefinition, normalizePlanId } from './billing.js';
import { getOrganisationName } from './db.js';
import { buildExdoxEmailHtml } from './emailHtml.js';
import { awsEnv } from './env.js';
import { getReceiptJsonObject, putReceiptJsonObject } from './s3.js';

const ses = new SESv2Client({});

type TrialNotificationRecord = {
  version: 1;
  subscriptionId: string;
  organisationId: number;
  recipient: string;
  messageId: string | null;
  sentAt: string;
};

function notificationKey(subscriptionId: string) {
  return `billing-notifications/free-trials/${subscriptionId}.json`;
}

async function loadNotification(subscriptionId: string) {
  try {
    return await getReceiptJsonObject<TrialNotificationRecord>(notificationKey(subscriptionId));
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return null;
    throw error;
  }
}

function formatDate(timestamp: number | null | undefined) {
  if (!timestamp) return 'Not provided';
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/London',
  }).format(new Date(timestamp * 1000));
}

export async function sendFreeTrialStartedNotification(subscription: Stripe.Subscription, stripe: Stripe) {
  if (subscription.status !== 'trialing') return { sent: false, reason: 'not_trialing' as const };
  const existing = await loadNotification(subscription.id);
  if (existing) return { sent: false, reason: 'already_sent' as const, messageId: existing.messageId };

  const organisationId = Number(subscription.metadata.organisationId);
  if (!Number.isFinite(organisationId) || organisationId <= 0) {
    throw new Error('The new Stripe trial is missing its Exdox organisation ID.');
  }
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id;
  if (!customerId) throw new Error('The new Stripe trial is missing its customer ID.');
  const customer = await stripe.customers.retrieve(customerId);
  if (customer.deleted) throw new Error('The Stripe customer for the new trial has been deleted.');

  const organisationName = await getOrganisationName(organisationId);
  const plan = getPlanDefinition(normalizePlanId(subscription.metadata.planId));
  const ownerName = customer.name?.trim() || 'Not provided';
  const ownerEmail = customer.email?.trim() || 'Not provided';
  const includedUsers = subscription.metadata.includedUsers || String(plan.includedUsers ?? 'Custom');
  const monthlyDocuments = subscription.metadata.monthlyDocumentLimit || String(plan.monthlyDocumentLimit ?? 'Custom');
  const trialStartedAt = formatDate(subscription.trial_start ?? subscription.created);
  const trialEndsAt = formatDate(subscription.trial_end);
  const details = [
    `Business: ${organisationName}`,
    `Owner: ${ownerName}`,
    `Owner email: ${ownerEmail}`,
    `Plan: ${plan.label}`,
    `Trial started: ${trialStartedAt}`,
    `Trial ends: ${trialEndsAt}`,
    `Included users: ${includedUsers}`,
    `Monthly document allowance: ${monthlyDocuments}`,
    `Exdox workspace ID: ${organisationId}`,
  ];
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    ReplyToAddresses: [awsEnv.inviteEmailFrom],
    Destination: { ToAddresses: [awsEnv.contactInboxEmail] },
    Content: {
      Simple: {
        Subject: { Data: `New Exdox free trial: ${organisationName}` },
        Body: {
          Text: { Data: ['A new Exdox free trial has successfully started in Stripe.', '', ...details].join('\n') },
          Html: { Data: buildExdoxEmailHtml({ heading: 'New Exdox free trial', paragraphs: ['A new Exdox free trial has successfully started in Stripe.'], details }) },
        },
      },
    },
  }));

  const record: TrialNotificationRecord = {
    version: 1,
    subscriptionId: subscription.id,
    organisationId,
    recipient: awsEnv.contactInboxEmail,
    messageId: response.MessageId ?? null,
    sentAt: new Date().toISOString(),
  };
  await putReceiptJsonObject(notificationKey(subscription.id), record);
  return { sent: true, messageId: record.messageId };
}
