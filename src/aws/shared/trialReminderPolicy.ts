import type Stripe from 'stripe';

const DAY_MS = 24 * 60 * 60 * 1000;
export type TrialReminderKind = 'ending' | 'ended';

export function trialReminderKind(subscription: Pick<Stripe.Subscription, 'status' | 'trial_end' | 'metadata'>, now = Date.now()): TrialReminderKind | null {
  if (!subscription.metadata.organisationId || !subscription.trial_end) return null;
  const remaining = subscription.trial_end * 1000 - now;
  if (subscription.status === 'trialing' && remaining > 0 && remaining <= 3 * DAY_MS) return 'ending';
  if (subscription.status === 'paused' && remaining <= 0 && remaining >= -7 * DAY_MS) return 'ended';
  return null;
}
