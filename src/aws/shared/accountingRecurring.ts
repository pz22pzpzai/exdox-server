import { createHash, randomUUID } from 'node:crypto';
import { createDraft, type AccountingDraft } from './accountingLifecycle.js';
import { validBookDate } from './accountingSafeguards.js';

export type AccountingRecurrence = {
  id: string; sourceDraftId: string; kind: 'invoice' | 'bill'; label: string;
  frequency: 'weekly' | 'monthly'; dayOfMonth: number; nextDate: string;
  dueDays: number; numberPrefix: string; paused: boolean;
  template: AccountingDraft; lastError?: string; createdAt: string; createdBy: string;
};

export function createRecurrence(input: unknown, draft: AccountingDraft, by: string, today: string): AccountingRecurrence {
  const data = input as Record<string, unknown>;
  const nextDate = String(data.nextDate ?? '');
  const frequency = String(data.frequency ?? '');
  const dueDays = Number(data.dueDays);
  const numberPrefix = String(data.numberPrefix ?? '').trim();
  const label = String(data.label ?? '').trim();
  if (!validBookDate(nextDate) || nextDate < today || !['weekly', 'monthly'].includes(frequency) || !Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365 || !/^[A-Za-z0-9_-]{1,50}$/.test(numberPrefix) || label.length < 2 || label.length > 100) throw new Error('Enter a future start date, weekly or monthly frequency, 0–365 payment days, short number prefix, and schedule name.');
  return { id: randomUUID(), sourceDraftId: draft.id, kind: draft.document.kind, label, frequency: frequency as AccountingRecurrence['frequency'], dayOfMonth: Number(nextDate.slice(8)), nextDate, dueDays, numberPrefix, paused: false, template: draft, createdAt: new Date().toISOString(), createdBy: by };
}

export function advanceRecurrence(schedule: AccountingRecurrence, date: string): string {
  const current = new Date(`${date}T00:00:00Z`);
  if (schedule.frequency === 'weekly') { current.setUTCDate(current.getUTCDate() + 7); return current.toISOString().slice(0, 10); }
  const year = current.getUTCFullYear();
  const month = current.getUTCMonth() + 1;
  const first = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(schedule.dayOfMonth, lastDay));
  return first.toISOString().slice(0, 10);
}

export function recurringDraft(schedule: AccountingRecurrence, date: string): AccountingDraft {
  const due = new Date(`${date}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + schedule.dueDays);
  const number = `${schedule.numberPrefix}-${date.replaceAll('-', '')}`;
  const template = schedule.template;
  const draft = createDraft({ ...template.document, contactId: template.contactId, number, date, taxDate: date, dueDate: due.toISOString().slice(0, 10) }, 'Accounting schedule');
  const digest = createHash('sha256').update(`${schedule.id}:${date}`).digest('hex');
  const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
  return { ...draft, id };
}
