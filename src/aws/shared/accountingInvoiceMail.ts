import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { awsEnv } from './env.js';
import type { AccountingDocument } from './accounting.js';
import { accountingInvoiceText } from './accountingLifecycle.js';

const ses = new SESv2Client({});
export async function sendAccountingInvoice(document: AccountingDocument, recipient: string) {
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    Destination: { ToAddresses: [recipient] },
    Content: { Simple: { Subject: { Data: `Invoice ${document.number} from ${document.issuerName}`, Charset: 'UTF-8' }, Body: { Text: { Data: accountingInvoiceText(document), Charset: 'UTF-8' } } } },
  }));
  return response.MessageId ?? null;
}
