import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

import { applySchema } from '../aws/shared/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemaPath = path.resolve(__dirname, '../../schema/001_exdox.sql');

async function main() {
  const sql = await fs.readFile(schemaPath, 'utf8');
  await applySchema(sql);
  console.log(`Applied schema from ${schemaPath}`);
}

void main().catch((error) => {
  console.error('Failed to apply schema', error);
  process.exitCode = 1;
});
