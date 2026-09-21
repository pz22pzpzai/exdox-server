import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import Stripe from 'stripe';

import { getPlanDefinition, normalizePlanId } from './billing.js';
import { getOrganisationName } from './db.js';
import { buildExdoxEmailHtml } from './emailHtml.js';
import { awsEnv } from './env.js';
import { getReceiptJsonObject, putReceiptJsonObject } from './s3.js';

const ses = new SESv2Client({});

type TrialNotificationRecord = {
  version: 1 | 2;
  subscriptionId: string | null;
  organisationId: number;
  recipient: string;
  messageId: string | null;
  sentAt: string;
  source?: 'registration' | 'stripe_trial';
};

function legacyNotificationKey(subscriptionId: string) {
  return `billing-notifications/free-trials/${subscriptionId}.json`;
}

function notificationKey(organisationId: number) {
  return `billing-notifications/free-trials/organisation-${organisationId}.json`;
}

async function loadObject(key: string) {
  try {
    return await getReceiptJsonObject<TrialNotificationRecord>(key);
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number }; name?: string }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NoSuchKey' || name === 'NotFound') return null;
    throw error;
  }
}

async function loadNotification(organisationId: number, subscriptionId?: string | null) {
  const current = await loadObject(notificationKey(organisationId));
  if (current || !subscriptionId) return current;
  return loadObject(legacyNotificationKey(subscriptionId));
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
  return sendNewWorkspaceSignupNotification({
    organisationId,
    organisationName,
    ownerName,
    ownerEmail,
    planId: subscription.metadata.planId,
    includedUsers,
    monthlyDocuments,
    source: 'stripe_trial',
    subscriptionId: subscription.id,
    trialStartedAt,
    trialEndsAt,
  });
}

export async function sendNewWorkspaceSignupNotification(input: {
  organisationId: number;
  organisationName: string;
  ownerName: string | null;
  ownerEmail: string;
  planId: string;
  includedUsers: string | number;
  monthlyDocuments: string | number;
  source: 'registration' | 'stripe_trial';
  subscriptionId?: string | null;
  trialStartedAt?: string;
  trialEndsAt?: string;
}) {
  const existing = await loadNotification(input.organisationId, input.subscriptionId);
  if (existing) return { sent: false, reason: 'already_sent' as const, messageId: existing.messageId };

  const plan = getPlanDefinition(normalizePlanId(input.planId));
  const details = [
    `Business: ${input.organisationName}`,
    `Owner: ${input.ownerName?.trim() || 'Not provided'}`,
    `Owner email: ${input.ownerEmail}`,
    `Plan: ${plan.label}`,
    ...(input.trialStartedAt ? [`Trial started: ${input.trialStartedAt}`] : []),
    ...(input.trialEndsAt ? [`Trial ends: ${input.trialEndsAt}`] : []),
    `Included users: ${input.includedUsers}`,
    `Monthly document allowance: ${input.monthlyDocuments}`,
    `Exdox workspace ID: ${input.organisationId}`,
  ];
  const heading = input.source === 'registration' ? 'New Exdox signup' : 'New Exdox free trial';
  const summary = input.source === 'registration'
    ? 'A new Exdox business or sole-trader workspace has been registered. Stripe trial confirmation may still be in progress.'
    : 'A new Exdox free trial has successfully started in Stripe.';
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    ReplyToAddresses: [awsEnv.inviteEmailFrom],
    Destination: { ToAddresses: [awsEnv.contactInboxEmail] },
    Content: {
      Simple: {
        Subject: { Data: `${heading}: ${input.organisationName}` },
        Body: {
          Text: { Data: [summary, '', ...details].join('\n') },
          Html: { Data: buildExdoxEmailHtml({ heading, paragraphs: [summary], details }) },
        },
      },
    },
  }));

  const record: TrialNotificationRecord = {
    version: 2,
    subscriptionId: input.subscriptionId ?? null,
    organisationId: input.organisationId,
    recipient: awsEnv.contactInboxEmail,
    messageId: response.MessageId ?? null,
    sentAt: new Date().toISOString(),
    source: input.source,
  };
  await putReceiptJsonObject(notificationKey(input.organisationId), record);
  return { sent: true, messageId: record.messageId };
}

export async function sendNewWorkspaceSignupNotificationWithRetry(
  input: Parameters<typeof sendNewWorkspaceSignupNotification>[0],
  attempts = 3,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendNewWorkspaceSignupNotification(input);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 400));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not send the internal signup notification.');
}
