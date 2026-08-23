import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';

const ses = new SESv2Client({});

export async function sendExpenseExportSummaryEmail(input: {
  toEmail: string;
  fullName: string | null;
  organisationName: string;
  approvedClaimCount: number;
  approvedDocumentCount: number;
  totalAmount: number;
  currency: string;
  exportedAt: string;
}) {
  const recipientName = input.fullName || input.toEmail;
  const formattedTotal = new Intl.NumberFormat('en-GB', {
    style: 'currency',
    currency: input.currency || 'GBP',
  }).format(input.totalAmount);

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: awsEnv.inviteEmailFrom,
      Destination: { ToAddresses: [input.toEmail] },
      Content: {
        Simple: {
          Subject: { Data: `Your approved expense summary | ${input.organisationName}` },
          Body: {
            Text: {
              Data: [
                `Hi ${recipientName},`,
                '',
                `Your approved expense summary was prepared for ${input.organisationName} on ${input.exportedAt}.`,
                '',
                `Approved claims: ${input.approvedClaimCount}`,
                `Approved receipt lines: ${input.approvedDocumentCount}`,
                `Approved total: ${formattedTotal}`,
                '',
                'Sign in to Exdox to view your expense claims and their current payment status.',
                '',
                'Thanks,',
                'The Exdox team',
              ].join('\n'),
            },
          },
        },
      },
    }),
  );
}
