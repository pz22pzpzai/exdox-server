import { purgeExpiredRecycleBin } from '../shared/db.js';

export async function handler() {
  await purgeExpiredRecycleBin();
  return { statusCode: 200, body: JSON.stringify({ success: true }) };
}
