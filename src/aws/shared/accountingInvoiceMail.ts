import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { awsEnv } from './env.js';
import type { AccountingDocument } from './accounting.js';
import { accountingInvoiceText } from './accountingLifecycle.js';
import { reminderText } from './accountingReminders.js';

const ses = new SESv2Client({});
type Tracking = { organisationId: number | string; mailId: string };
async function send(document: AccountingDocument, recipient: string, tracking: Tracking, replyToEmail?: string, reminderAmountPence?: number) {
  const configurationSet = process.env.ACCOUNTING_SES_CONFIGURATION_SET;
  if (!configurationSet) throw new Error('Accounting email tracking is not configured.');
  const response = await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    ...(replyToEmail ? { ReplyToAddresses: [replyToEmail] } : {}),
    Destination: { ToAddresses: [recipient] },
    ConfigurationSetName: configurationSet,
    EmailTags: [{ Name: 'accountingOrg', Value: String(tracking.organisationId) }, { Name: 'accountingMail', Value: tracking.mailId }],
    Content: { Simple: { Subject: { Data: `${reminderAmountPence === undefined ? 'Invoice' : 'Payment reminder for invoice'} ${document.number} from ${document.issuerName}`, Charset: 'UTF-8' }, Body: { Text: { Data: reminderAmountPence === undefined ? accountingInvoiceText(document) : reminderText(document, reminderAmountPence), Charset: 'UTF-8' } } } },
  }));
  return response.MessageId ?? null;
}
export const sendAccountingInvoice = (document: AccountingDocument, recipient: string, tracking: Tracking, replyToEmail?: string) => send(document, recipient, tracking, replyToEmail);
export const sendAccountingReminder = (document: AccountingDocument, recipient: string, tracking: Tracking, amountPence: number, replyToEmail: string) => send(document, recipient, tracking, replyToEmail, amountPence);
