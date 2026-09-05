import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';
import { buildExdoxEmailHtml } from './emailHtml.js';

const ses = new SESv2Client({});

export async function sendContactEmail(input: {
  fullName: string;
  email: string;
  organisationName: string | null;
  subject: string;
  message: string;
}) {
  if (!awsEnv.inviteEmailFrom) {
    console.info('Contact email not sent because INVITE_EMAIL_FROM is not configured.', {
      email: input.email,
      subject: input.subject,
    });
    return {
      delivered: false,
      channel: 'not_configured' as const,
    };
  }

  const organisationLine = input.organisationName?.trim() ? input.organisationName.trim() : 'Not provided';
  const safeSubject = input.subject.trim() || 'General enquiry';

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      ReplyToAddresses: [input.email],
      Destination: {
        ToAddresses: [awsEnv.contactInboxEmail],
      },
      Content: {
        Simple: {
          Subject: {
            Data: `Exdox contact form: ${safeSubject}`,
          },
          Body: {
            Text: {
              Data: [
                `Full name: ${input.fullName}`,
                `Email: ${input.email}`,
                `Organisation: ${organisationLine}`,
                `Subject: ${safeSubject}`,
                '',
                'Message:',
                input.message.trim(),
              ].join('\n'),
            },
            Html: {
              Data: buildExdoxEmailHtml({
                heading: `Contact form: ${safeSubject}`,
                details: [
                  `Full name: ${input.fullName}`,
                  `Email: ${input.email}`,
                  `Organisation: ${organisationLine}`,
                  `Subject: ${safeSubject}`,
                ],
                paragraphs: [input.message.trim()],
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
