import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';
import { buildExdoxEmailHtml } from './emailHtml.js';

const ses = new SESv2Client({});

export async function sendRegistrationConfirmationEmail(input: {
  toEmail: string;
  fullName: string | null;
  organisationName: string;
  confirmationLink: string;
  locale?: 'de';
}) {
  if (!awsEnv.inviteEmailFrom) {
    console.info('Registration confirmation email not sent because INVITE_EMAIL_FROM is not configured.', {
      toEmail: input.toEmail,
      organisationName: input.organisationName,
    });
    return {
      delivered: false,
      channel: 'not_configured' as const,
    };
  }

  const recipientName = input.fullName || input.toEmail;

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      ReplyToAddresses: [awsEnv.inviteEmailFrom],
      Destination: {
        ToAddresses: [input.toEmail],
      },
      Content: {
        Simple: {
          Subject: {
            Data: input.locale === 'de' ? `Bestätigen Sie Ihre Exdox-E-Mail für ${input.organisationName}` : `Confirm your exdox email for ${input.organisationName}`,
          },
          Body: {
            Text: {
              Data: input.locale === 'de' ? [
                `Guten Tag ${recipientName},`,
                '',
                `vielen Dank, dass Sie ${input.organisationName} bei Exdox eingerichtet haben.`,
                'Bestätigen Sie Ihre E-Mail-Adresse, um Ihren Arbeitsbereich zu aktivieren:',
                input.confirmationLink,
                '',
                'Wenn Sie dieses Konto nicht erstellt haben, können Sie diese Nachricht ignorieren.',
              ].join('\n') : [
                `Hi ${recipientName},`,
                '',
                `Thanks for creating ${input.organisationName} on exdox.`,
                'Confirm your email address to activate your workspace:',
                input.confirmationLink,
                '',
                'If you did not create this account, you can ignore this email.',
              ].join('\n'),
            },
            Html: {
              Data: buildExdoxEmailHtml({
                locale: input.locale,
                heading: input.locale === 'de' ? 'Bestätigen Sie Ihre Exdox-E-Mail' : 'Confirm your Exdox email',
                greeting: input.locale === 'de' ? `Guten Tag ${recipientName},` : `Hi ${recipientName},`,
                paragraphs: input.locale === 'de' ? [
                  `Vielen Dank, dass Sie ${input.organisationName} bei Exdox eingerichtet haben.`,
                  'Bestätigen Sie Ihre E-Mail-Adresse, um Ihren Arbeitsbereich zu aktivieren.',
                  'Wenn Sie dieses Konto nicht erstellt haben, können Sie diese Nachricht ignorieren.',
                ] : [
                  `Thanks for creating ${input.organisationName} on Exdox.`,
                  'Confirm your email address to activate your workspace.',
                  'If you did not create this account, you can ignore this email.',
                ],
                action: { label: input.locale === 'de' ? 'E-Mail-Adresse bestätigen' : 'Confirm email address', url: input.confirmationLink },
              }),
            },
          },
        },
      },
    }),
  );

  return {
    delivered: true,
    channel: 'ses' as const,
  };
}

export async function sendRegistrationConfirmationEmailWithRetry(
  input: Parameters<typeof sendRegistrationConfirmationEmail>[0],
  attempts = 3,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendRegistrationConfirmationEmail(input);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not send the confirmation email.');
}

export async function sendWorkspaceWelcomeEmail(input: {
  toEmail: string;
  fullName: string | null;
  organisationName: string;
  paymentRequired?: boolean;
}) {
  const recipientName = input.fullName || input.toEmail;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      ReplyToAddresses: [awsEnv.inviteEmailFrom],
      Destination: {
        ToAddresses: [input.toEmail],
      },
      Content: {
        Simple: {
          Subject: {
            Data: `Welcome to exdox - ${input.organisationName}`,
          },
          Body: {
            Text: {
              Data: [
                `Hi ${recipientName},`,
                '',
                input.paymentRequired ? 'Your email is confirmed. Complete your selected monthly plan in secure checkout to open your workspace.' : 'Your email is confirmed and your exdox workspace is ready.',
                '',
                'Recommended next steps:',
                ...(input.paymentRequired ? ['1. Sign in and complete secure Stripe checkout.', '2. After payment succeeds, open your workspace.'] : ['1. Upload your first receipt or invoice.', '2. Review the extracted details and approve the document.', '3. Invite your team from Profile/Settings.']),
                '',
                `Open your workspace: https://exdox.co.uk/${input.paymentRequired ? 'login' : 'overview'}`,
                'Help and support: https://exdox.co.uk/contact',
                '',
                'Exdox support',
                'contact@exdox.co.uk',
              ].join('\n'),
            },
            Html: {
              Data: buildExdoxEmailHtml({
                heading: `Welcome to Exdox - ${input.organisationName}`,
                greeting: `Hi ${recipientName},`,
                paragraphs: [
                  input.paymentRequired ? 'Your email is confirmed. Complete your selected monthly plan in secure checkout to open your workspace.' : 'Your email is confirmed and your Exdox workspace is ready.',
                  input.paymentRequired ? 'Sign in and complete secure Stripe checkout. Your workspace opens after payment succeeds.' : 'Recommended next steps:\n1. Upload your first receipt or invoice.\n2. Review the extracted details and approve the document.\n3. Invite your team from Profile/Settings.',
                ],
                action: { label: input.paymentRequired ? 'Sign in to complete payment' : 'Open your workspace', url: `https://exdox.co.uk/${input.paymentRequired ? 'login' : 'overview'}` },
                links: [{ label: 'Help and support', url: 'https://exdox.co.uk/contact' }],
              }),
            },
          },
        },
      },
    }),
  );
}
