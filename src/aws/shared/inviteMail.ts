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
              Data: buildInviteHtml(input),
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

function buildInviteHtml(input: Parameters<typeof sendInviteEmail>[0]) {
  const inviterName = escapeHtml(input.inviterName);
  const organisationName = escapeHtml(input.organisationName);
  const inviteLink = escapeHtml(input.inviteLink);
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;background:#eef4f8;font-family:Arial,sans-serif;color:#10203d">
    <div style="max-width:600px;margin:0 auto;padding:32px 20px">
      <div style="background:#ffffff;border:1px solid #d3dfeb;border-radius:16px;padding:32px">
        <div style="font-size:26px;font-weight:700;margin-bottom:24px">Exdox</div>
        <h1 style="font-size:24px;line-height:1.3;margin:0 0 16px">Join ${organisationName} on Exdox</h1>
        <p style="font-size:16px;line-height:1.6;margin:0 0 24px">${inviterName} invited you to join their Exdox workspace.</p>
        <a href="${inviteLink}" style="display:inline-block;background:#10203d;color:#ffffff;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:8px">Accept invitation</a>
        <p style="font-size:13px;line-height:1.6;color:#65758c;margin:28px 0 0">If the button does not work, paste this link into your browser:<br><a href="${inviteLink}" style="color:#087fc1;word-break:break-all">${inviteLink}</a></p>
        <p style="font-size:13px;line-height:1.6;color:#65758c;margin:18px 0 0">If you were not expecting this invitation, you can ignore this email.</p>
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
