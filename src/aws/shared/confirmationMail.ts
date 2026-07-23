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
