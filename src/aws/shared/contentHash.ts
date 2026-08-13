import crypto from 'node:crypto';

export function calculateContentSha256(content: Uint8Array) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function contentHashesMatch(left?: string | null, right?: string | null) {
  return Boolean(left && right && left.length === 64 && right.length === 64 && left === right);
}
