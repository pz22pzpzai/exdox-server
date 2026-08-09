import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';

const ses = new SESv2Client({});

export async function sendRegistrationConfirmationEmail(input: {
  toEmail: string;
  fullName: string | null;
  organisationName: string;
  confirmationLink: string;
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
      Destination: {
        ToAddresses: [input.toEmail],
      },
      Content: {
        Simple: {
          Subject: {
            Data: `Confirm your exdox email for ${input.organisationName}`,
          },
          Body: {
            Text: {
              Data: [
                `Hi ${recipientName},`,
                '',
                `Thanks for creating ${input.organisationName} on exdox.`,
                'Confirm your email address to activate your workspace:',
                input.confirmationLink,
                '',
                'If you did not create this account, you can ignore this email.',
              ].join('\n'),
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
}) {
  const recipientName = input.fullName || input.toEmail;
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
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
                'Your email is confirmed and your exdox workspace is ready.',
                '',
                'Recommended next steps:',
                '1. Upload your first receipt or invoice.',
                '2. Review the extracted details and approve the document.',
                '3. Invite your team from Profile/Settings.',
                '',
                'Open your workspace: https://exdox.co.uk/overview',
                'Help and support: https://exdox.co.uk/contact',
                '',
                'Exdox support',
                'contact@exdox.co.uk',
              ].join('\n'),
            },
          },
        },
      },
    }),
  );
}
