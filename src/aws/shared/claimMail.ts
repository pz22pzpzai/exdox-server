import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';

const ses = new SESv2Client({});

export async function sendClaimStatusEmail(input: {
  toEmail: string;
  fullName: string | null;
  claimName: string;
  status: 'approved' | 'published' | 'paid' | 'rejected';
}) {
  const recipientName = input.fullName || input.toEmail;
  const statusCopy = input.status === 'approved'
    ? 'Your expenses have been reviewed and approved. They are now pending payment.'
    : input.status === 'published'
      ? 'Your expense claim has been published and is available in Exdox.'
    : input.status === 'paid'
      ? 'Your approved expenses have been marked as paid.'
      : 'Your expense claim was not approved. Sign in to Exdox or contact your finance team for details.';

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      Destination: { ToAddresses: [input.toEmail] },
      Content: {
        Simple: {
          Subject: { Data: `Expense claim ${input.status}: ${input.claimName}` },
          Body: {
            Text: {
              Data: [
                `Hi ${recipientName},`,
                '',
                statusCopy,
                '',
                `Claim: ${input.claimName}`,
                '',
                'Sign in to Exdox to view the current claim status.',
              ].join('\n'),
            },
          },
        },
      },
    }),
  );
}
