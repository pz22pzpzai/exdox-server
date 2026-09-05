import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';
import { buildExdoxEmailHtml } from './emailHtml.js';

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
      method: 'not_configured' as const,
    };
  }

  const response = await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      ReplyToAddresses: [awsEnv.inviteEmailFrom],
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
                'Hello,',
                '',
                `${input.inviterName} invited you to join ${input.organisationName} on exdox.`,
                '',
                'Use the link below to finish setting your password and activate your account:',
                input.inviteLink,
                '',
                'If you were not expecting this invitation, you can ignore this email.',
                '',
                'Exdox support',
                'contact@exdox.co.uk',
              ].join('\n'),
            },
            Html: {
              Data: buildExdoxEmailHtml({
                heading: `Join ${input.organisationName} on Exdox`,
                greeting: 'Hello,',
                paragraphs: [
                  `${input.inviterName} invited you to join their Exdox workspace.`,
                  'Use the button below to finish setting your password and activate your account.',
                  'If you were not expecting this invitation, you can ignore this email.',
                ],
                action: {
                  label: 'Accept invitation',
                  url: input.inviteLink,
                },
              }),
            },
          },
        },
      },
    }),
  );

  return {
    delivered: true,
    method: 'email' as const,
    messageId: response.MessageId ?? null,
  };
}

export async function sendInviteEmailWithRetry(
  input: Parameters<typeof sendInviteEmail>[0],
  attempts = 3,
) {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await sendInviteEmail(input);
    } catch (error) {
      lastError = error;
      console.warn('Invite email attempt failed.', {
        attempt,
        attempts,
        toEmail: input.toEmail,
        message: error instanceof Error ? error.message : 'unknown delivery failure',
      });
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Could not send the invitation email.');
}
