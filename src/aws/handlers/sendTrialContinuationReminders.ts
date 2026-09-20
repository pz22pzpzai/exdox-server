import Stripe from 'stripe';

import { awsEnv } from '../shared/env.js';
import { sendTrialContinuationReminder } from '../shared/trialContinuationReminder.js';

export async function handler() {
  if (!awsEnv.stripeSecretKey) return { statusCode: 200, body: JSON.stringify({ success: true, skipped: 'stripe_not_configured' }) };
  const stripe = new Stripe(awsEnv.stripeSecretKey, { apiVersion: '2026-06-24.dahlia' });
  let sent = 0;
  let failed = 0;
  for (const status of ['trialing', 'paused'] as const) {
    for await (const subscription of stripe.subscriptions.list({ status, limit: 100 })) {
      try {
        if (await sendTrialContinuationReminder(subscription, stripe)) sent += 1;
      } catch (error) {
        failed += 1;
        console.error('Could not send trial continuation reminder', {
          subscriptionId: subscription.id,
          message: error instanceof Error ? error.message : 'Unknown reminder error',
        });
      }
    }
  }
  if (failed) throw new Error(`Failed to send ${failed} trial continuation reminder(s); ${sent} sent.`);
  return { statusCode: 200, body: JSON.stringify({ success: true, sent }) };
}
