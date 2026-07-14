export function requireEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function optionalEnv(name: string) {
  return process.env[name]?.trim() || null;
}

function optionalBooleanEnv(name: string) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) {
    return false;
  }
  return value === 'true' || value === '1' || value === 'yes';
}

export const awsEnv = {
  receiptBucketName: requireEnv('RECEIPT_BUCKET_NAME'),
  openAiApiKey: requireEnv('OPENAI_API_KEY'),
  openAiModel: process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-nano',
  jwtSecret: requireEnv('JWT_SECRET'),
  inviteEmailFrom: optionalEnv('INVITE_EMAIL_FROM'),
  inviteBaseUrl: process.env.INVITE_BASE_URL?.trim() || 'exdox://signup',
  receiptStoreMode: process.env.RECEIPT_STORE_MODE?.trim() || 's3',
  dbHost: optionalEnv('DB_HOST'),
  dbPort: Number(process.env.DB_PORT ?? 3306),
  dbName: optionalEnv('DB_NAME'),
  dbUser: optionalEnv('DB_USER'),
  dbPassword: optionalEnv('DB_PASSWORD'),
  dbIamAuthEnabled: optionalBooleanEnv('DB_IAM_AUTH_ENABLED'),
  dbIamRegion: process.env.DB_IAM_REGION?.trim() || process.env.AWS_REGION?.trim() || null,
  openBankingProvider: process.env.OPEN_BANKING_PROVIDER?.trim() || 'truelayer',
  openBankingAuthUrl: optionalEnv('OPEN_BANKING_AUTH_URL'),
  openBankingCallbackUrl:
    process.env.OPEN_BANKING_CALLBACK_URL?.trim() || 'https://app.exdox.co.uk/bank-callback',
  stripeSecretKey: optionalEnv('STRIPE_SECRET_KEY'),
  stripeWebhookSecret: optionalEnv('STRIPE_WEBHOOK_SECRET'),
  stripeCheckoutSuccessUrl:
    process.env.STRIPE_CHECKOUT_SUCCESS_URL?.trim() || 'https://app.exdox.co.uk/billing?checkout=success',
  stripeCheckoutCancelUrl:
    process.env.STRIPE_CHECKOUT_CANCEL_URL?.trim() || 'https://app.exdox.co.uk/billing?checkout=cancelled',
  stripeBillingPortalReturnUrl:
    process.env.STRIPE_BILLING_PORTAL_RETURN_URL?.trim() || 'https://app.exdox.co.uk/billing',
  stripePriceCaptureMonthly: optionalEnv('STRIPE_PRICE_CAPTURE_MONTHLY'),
  stripePriceCaptureAnnual: optionalEnv('STRIPE_PRICE_CAPTURE_ANNUAL'),
  stripePriceControlMonthly: optionalEnv('STRIPE_PRICE_CONTROL_MONTHLY'),
  stripePriceControlAnnual: optionalEnv('STRIPE_PRICE_CONTROL_ANNUAL'),
  stripePriceOperationsMonthly: optionalEnv('STRIPE_PRICE_OPERATIONS_MONTHLY'),
  stripePriceOperationsAnnual: optionalEnv('STRIPE_PRICE_OPERATIONS_ANNUAL'),
  stripePriceEnterpriseMonthly: optionalEnv('STRIPE_PRICE_ENTERPRISE_MONTHLY'),
  stripePriceEnterpriseAnnual: optionalEnv('STRIPE_PRICE_ENTERPRISE_ANNUAL'),
};
