import crypto from 'node:crypto';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { awsEnv } from './env.js';
import { getReceiptJsonObject, putReceiptJsonObject } from './s3.js';

type State = {
  emailEnabled: boolean;
  totpSecret: string | null;
  pendingTotpSecret: string | null;
  emailCodeHash: string | null;
  emailCodeExpiresAt: number;
  emailCodeSentAt: number;
  failures: number;
  lockedUntil: number;
  lastTotpStep: number;
};

const blank = (): State => ({ emailEnabled: false, totpSecret: null, pendingTotpSecret: null,
  emailCodeHash: null, emailCodeExpiresAt: 0, emailCodeSentAt: 0, failures: 0, lockedUntil: 0, lastTotpStep: -1 });
const key = (id: number) => `security/two-factor/${id}.json`;
const encryptionKey = crypto.scryptSync(awsEnv.jwtSecret, 'exdox-totp-secret-v1', 32);
const ses = new SESv2Client({});

function seal(secret: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey, iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url')).join('.');
}

function unseal(value: string) {
  const [iv, tag, data] = value.split('.');
  if (!iv || !tag || !data) throw new Error('Invalid authenticator configuration.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

export async function readTwoFactor(id: number): Promise<State> {
  try { return { ...blank(), ...(await getReceiptJsonObject<Partial<State>>(key(id))) }; }
  catch (error) {
    const failure = error as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
    if (failure.name === 'NoSuchKey' || failure.Code === 'NoSuchKey' || failure.$metadata?.httpStatusCode === 404) return blank();
    throw error;
  }
}

async function save(id: number, state: State) { await putReceiptJsonObject(key(id), state); }
export function twoFactorStatus(state: State) { return { emailEnabled: state.emailEnabled, authenticatorEnabled: Boolean(state.totpSecret) }; }
export function hasTwoFactor(state: State) { return state.emailEnabled || Boolean(state.totpSecret); }

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(bytes: Buffer) {
  let bits = 0, value = 0, result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += alphabet[(value >>> (bits -= 5)) & 31]; } }
  return bits ? result + alphabet[(value << (5 - bits)) & 31] : result;
}
function decodeBase32(value: string) {
  let bits = 0, current = 0; const result: number[] = [];
  for (const char of value.toUpperCase().replace(/\s/g, '')) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error('Invalid authenticator secret.');
    current = (current << 5) | digit; bits += 5;
    if (bits >= 8) { result.push((current >>> (bits -= 8)) & 255); }
  }
  return Buffer.from(result);
}
export function generateTotpCode(secret: string, step: number) {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const hash = crypto.createHmac('sha1', decodeBase32(secret)).update(counter).digest();
  const offset = hash[hash.length - 1]! & 15;
  return ((hash.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
function matchingStep(secret: string, code: string) {
  if (!/^\d{6}$/.test(code)) return -1;
  const now = Math.floor(Date.now() / 30_000);
  for (const step of [now - 1, now, now + 1]) {
    if (crypto.timingSafeEqual(Buffer.from(generateTotpCode(secret, step)), Buffer.from(code))) return step;
  }
  return -1;
}
function hashCode(code: string) { return crypto.createHmac('sha256', awsEnv.jwtSecret).update(code).digest('hex'); }

export async function beginAuthenticator(id: number, email: string) {
  const state = await readTwoFactor(id);
  if (state.totpSecret) throw new Error('Authenticator is already enabled.');
  const secret = base32(crypto.randomBytes(20));
  state.pendingTotpSecret = seal(secret);
  await save(id, state);
  return { secret, uri: `otpauth://totp/Exdox:${encodeURIComponent(email)}?secret=${secret}&issuer=Exdox&algorithm=SHA1&digits=6&period=30` };
}
export async function enableAuthenticator(id: number, code: string) {
  const state = await readTwoFactor(id);
  if (!state.pendingTotpSecret || matchingStep(unseal(state.pendingTotpSecret), code) < 0) throw new Error('Enter the current six-digit authenticator code.');
  state.totpSecret = state.pendingTotpSecret; state.pendingTotpSecret = null;
  await save(id, state);
  return twoFactorStatus(state);
}

export async function sendEmailCode(id: number, email: string, purpose: 'login' | 'setup') {
  const state = await readTwoFactor(id);
  const now = Date.now();
  if (state.lockedUntil > now) throw new Error('Too many attempts. Try again in 15 minutes.');
  if (state.emailCodeSentAt + 60_000 > now && state.emailCodeExpiresAt > now) return false;
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const subject = purpose === 'login' ? 'Your Exdox login code' : 'Confirm Exdox email two-factor authentication';
  await ses.send(new SendEmailCommand({
    FromEmailAddress: awsEnv.inviteEmailFrom,
    Destination: { ToAddresses: [email] },
    Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: `Your Exdox verification code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.` } } } },
  }));
  state.emailCodeHash = hashCode(code); state.emailCodeExpiresAt = now + 600_000; state.emailCodeSentAt = now;
  await save(id, state);
  return true;
}
export async function enableEmail(id: number, code: string) {
  const state = await readTwoFactor(id);
  if (!await checkCode(id, state, code, 'email', true)) throw new Error('The email code is incorrect or expired.');
  state.emailEnabled = true; state.emailCodeHash = null; await save(id, state);
  return twoFactorStatus(state);
}
async function checkCode(id: number, state: State, code: string, method: 'email' | 'authenticator', setup = false) {
  if (state.lockedUntil > Date.now()) throw new Error('Too many attempts. Try again in 15 minutes.');
  let valid = false;
  if (method === 'email' && (state.emailEnabled || setup) && /^\d{6}$/.test(code) && state.emailCodeHash && state.emailCodeExpiresAt > Date.now()) {
    valid = crypto.timingSafeEqual(Buffer.from(hashCode(code)), Buffer.from(state.emailCodeHash));
    if (valid) state.emailCodeHash = null;
  }
  if (method === 'authenticator' && state.totpSecret) {
    const step = matchingStep(unseal(state.totpSecret), code);
    valid = step > state.lastTotpStep;
    if (valid) state.lastTotpStep = step;
  }
  if (valid) { state.failures = 0; state.lockedUntil = 0; }
  else { state.failures += 1; if (state.failures >= 5) { state.lockedUntil = Date.now() + 900_000; state.failures = 0; } }
  await save(id, state);
  return valid;
}
export async function verifyTwoFactor(id: number, code: string, method: 'email' | 'authenticator') {
  const state = await readTwoFactor(id);
  return checkCode(id, state, code, method);
}
export async function disableTwoFactor(id: number, method: 'email' | 'authenticator', code: string, codeMethod: 'email' | 'authenticator') {
  const state = await readTwoFactor(id);
  if (!await checkCode(id, state, code, codeMethod)) throw new Error('The verification code is incorrect or expired.');
  if (method === 'email') state.emailEnabled = false;
  else state.totpSecret = null;
  await save(id, state);
  return twoFactorStatus(state);
}
