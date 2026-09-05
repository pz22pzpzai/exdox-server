import type { InboxStatus, UserRole } from '../types.js';

const salesStatuses = new Set<InboxStatus>([
  'Processing',
  'Review',
  'Ready',
  'Published',
  'Paid',
  'Rejected',
]);

export function isSalesStatus(value: string): value is InboxStatus {
  return salesStatuses.has(value as InboxStatus);
}

export function canChangeSalesStatus(role: UserRole, currentStatus: InboxStatus, requestedStatus: string) {
  return requestedStatus === currentStatus || (role === 'Business_Admin' && isSalesStatus(requestedStatus));
}
