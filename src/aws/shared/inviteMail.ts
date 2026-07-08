import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';

const ses = new SESv2Client({});

export async function sendInviteEmail(input: {
  toEmail: string;
  inviterName: string;
  organisationName: string;
  inviteLink: string;
}) {
  if (!awsEnv.inviteEmailFrom) {
    console.info('Invite email not sent because INVITE_EMAIL_FROM is not configured.', {
      toEmail: input.toEmail,
      inviteLink: input.inviteLink,
    });
    return {
      delivered: false,
      channel: 'not_configured' as const,
    };
  }

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      Destination: {
        ToAddresses: [input.toEmail],
      },
      Content: {
        Simple: {
          Subject: {
            Data: `You're invited to join ${input.organisationName} on exdox`,
          },
          Body: {
            Text: {
              Data: [
                `${input.inviterName} invited you to join ${input.organisationName} on exdox.`,
                '',
                'Use the link below to finish setting your password and activate your account:',
                input.inviteLink,
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
