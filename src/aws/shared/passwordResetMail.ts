import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';
import { buildExdoxEmailHtml } from './emailHtml.js';

const ses = new SESv2Client({});

export async function sendPasswordResetEmail(input: {
  toEmail: string;
  fullName: string | null;
  organisationName: string;
  resetLink: string;
  locale?: 'de';
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
            Data: input.locale === 'de' ? `Setzen Sie Ihr Exdox-Passwort für ${input.organisationName} zurück` : `Reset your Exdox password for ${input.organisationName}`,
          },
          Body: {
            Text: {
              Data: input.locale === 'de' ? [
                `Guten Tag ${recipientName},`,
                '',
                `für Ihren Exdox-Zugang zu ${input.organisationName} wurde eine Passwortänderung angefordert.`,
                'Über diesen sicheren Link können Sie ein neues Passwort wählen:',
                input.resetLink,
                '',
                'Der Link ist eine Stunde gültig.',
                'Wenn Sie die Änderung nicht angefordert haben, können Sie diese Nachricht ignorieren.',
              ].join('\n') : [
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
                locale: input.locale,
                heading: input.locale === 'de' ? 'Exdox-Passwort zurücksetzen' : 'Reset your Exdox password',
                greeting: input.locale === 'de' ? `Guten Tag ${recipientName},` : `Hi ${recipientName},`,
                paragraphs: input.locale === 'de' ? [
                  `Für Ihren Exdox-Zugang zu ${input.organisationName} wurde eine Passwortänderung angefordert.`,
                  'Wählen Sie über die Schaltfläche ein neues Passwort. Der Link ist eine Stunde gültig.',
                  'Wenn Sie die Änderung nicht angefordert haben, können Sie diese Nachricht ignorieren.',
                ] : [
                  `We received a request to reset the password for your Exdox access in ${input.organisationName}.`,
                  'Use the secure button below to choose a new password. This link expires in 1 hour.',
                  'If you did not request this change, you can ignore this email.',
                ],
                action: { label: input.locale === 'de' ? 'Passwort zurücksetzen' : 'Reset password', url: input.resetLink },
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
