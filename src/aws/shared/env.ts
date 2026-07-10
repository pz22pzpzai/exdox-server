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
};
