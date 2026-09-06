import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';

import { awsEnv } from './env.js';
import type { SalesDocumentRow } from '../types.js';

const ses = new SESv2Client({});

export async function sendSalesDocumentEmail(input: { document: SalesDocumentRow; recipient: string; pdf: Buffer }) {
  const boundary = `exdox-${Date.now().toString(36)}`;
  const kind = input.document.kind === 'credit_note' ? 'Credit note' : `${input.document.kind[0].toUpperCase()}${input.document.kind.slice(1)}`;
  const subject = `${kind} ${input.document.number} from Exdox`;
  const text = [
    `Hello ${input.document.customerName},`, '',
    `Please find ${kind.toLowerCase()} ${input.document.number} attached.`,
    `Total: ${input.document.currency} ${input.document.total.toFixed(2)}`,
    input.document.dueDate ? `Due date: ${input.document.dueDate}` : '', '',
    'Sent securely through Exdox.',
  ].filter(Boolean).join('\r\n');
  const raw = [
    `From: ${awsEnv.inviteEmailFrom}`,
    `To: ${input.recipient}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`, '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit', '', text, '',
    `--${boundary}`,
    'Content-Type: application/pdf',
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${input.document.number}.pdf"`, '',
    input.pdf.toString('base64').match(/.{1,76}/g)?.join('\r\n') ?? '', '',
    `--${boundary}--`, '',
  ].join('\r\n');
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    Destination: { ToAddresses: [input.recipient] },
    Content: { Raw: { Data: Buffer.from(raw) } },
  }));
  return response.MessageId ?? null;
}
