import type { AccountingDocument } from './accounting.js';
import type { AgingRow } from './accountingAging.js';

export type AccountingReminderSettings = { enabled: boolean; days: number[]; replyToEmail: string; excludedDocumentIds: string[]; updatedAt: string; updatedBy: string };
export type AccountingEmailRecord = { id: string; documentId: string; recipient: string; kind: 'invoice' | 'reminder'; milestoneDay?: number; status: 'pending' | 'accepted' | 'delivered' | 'delayed' | 'bounced' | 'complained' | 'rejected' | 'uncertain'; requestedAt: string; acceptedAt?: string; deliveredAt?: string; messageId?: string };
export const defaultReminderSettings: AccountingReminderSettings = { enabled: false, days: [7, 14, 30], replyToEmail: '', excludedDocumentIds: [], updatedAt: '', updatedBy: '' };

export function reminderCandidate(document: AccountingDocument, row: AgingRow | undefined, records: AccountingEmailRecord[], settings: AccountingReminderSettings, today: string): { recipient: string; milestoneDay: number; amountPence: number } | null {
  if (!settings.enabled || document.kind !== 'invoice' || settings.excludedDocumentIds.includes(document.id)) return null;
  const original = records.filter((item) => item.documentId === document.id && item.kind === 'invoice').sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))[0];
  if (!original || original.status !== 'delivered' || !original.deliveredAt || original.deliveredAt.slice(0, 10) >= today) return null;
  if (records.some((item) => item.documentId === document.id && item.kind === 'reminder' && item.status !== 'delivered')) return null;
  if (!row || row.outstandingPence <= 0) return null;
  const milestoneDay = settings.days.find((day) => row.daysOverdue === day && !records.some((item) => item.documentId === document.id && item.kind === 'reminder' && item.milestoneDay === day));
  return milestoneDay === undefined ? null : { recipient: original.recipient, milestoneDay, amountPence: row.outstandingPence };
}

export function reminderText(document: AccountingDocument, amountPence: number) {
  return `Hello,\n\nThis is a payment reminder for invoice ${document.number} from ${document.issuerName}. The amount currently outstanding is GBP ${(amountPence / 100).toFixed(2)}. The invoice was due on ${document.dueDate}.\n\nPlease refer to the original invoice for payment instructions. If you have already paid, please contact ${document.issuerName} so the payment can be recorded.\n\nThank you.\n${document.issuerName}`;
}
