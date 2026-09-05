import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';
import { buildExdoxEmailHtml } from './emailHtml.js';

const ses = new SESv2Client({});

export async function sendPasswordResetEmail(input: {
  toEmail: string;
  fullName: string | null;
  organisationName: string;
  resetLink: string;
}) {
  if (!awsEnv.inviteEmailFrom) {
    console.info('Password reset email not sent because INVITE_EMAIL_FROM is not configured.', {
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
            Data: `Reset your Exdox password for ${input.organisationName}`,
          },
          Body: {
            Text: {
              Data: [
                `Hi ${recipientName},`,
                '',
                `We received a request to reset the password for your Exdox access in ${input.organisationName}.`,
                'Use the secure link below to choose a new password:',
                input.resetLink,
                '',
                'This link expires in 1 hour.',
                'If you did not request this change, you can ignore this email.',
              ].join('\n'),
            },
            Html: {
              Data: buildExdoxEmailHtml({
                heading: 'Reset your Exdox password',
                greeting: `Hi ${recipientName},`,
                paragraphs: [
                  `We received a request to reset the password for your Exdox access in ${input.organisationName}.`,
                  'Use the secure button below to choose a new password. This link expires in 1 hour.',
                  'If you did not request this change, you can ignore this email.',
                ],
                action: { label: 'Reset password', url: input.resetLink },
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
