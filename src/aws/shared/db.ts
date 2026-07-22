import crypto from 'node:crypto';

import { Signer } from '@aws-sdk/rds-signer';
import mysql from 'mysql2/promise';

import { awsEnv } from './env.js';
import { sanitizeText } from './helpers.js';
import { deleteReceiptObject, getReceiptJsonObject, listReceiptJsonKeys, putReceiptJsonObject } from './s3.js';
import {
  type AuthenticatedUser,
  type BankRequisitionRow,
  type BankTransactionRow,
  type BillingCycle,
  type BillingPlanId,
  type BillingStatus,
  type ExpenseClaimRow,
  type NormalizedExpenseDocument,
  type OrganisationBillingSummary,
  type OrganisationSettings,
  type PaymentMethod,
  type ReconciliationCandidate,
  type ReceiptRow,
  type ReceiptSource,
  type SupplierRuleRow,
  type UserRecord,
  type UserRole,
  type WorkspaceContext,
} from '../types.js';
import {
  defaultTrialEndsAt,
  normalizeBillingCycle,
  normalizeBillingStatus,
  normalizePlanId,
} from './billing.js';

const usesMysql =
  awsEnv.receiptStoreMode === 'mysql' &&
  awsEnv.dbHost &&
  awsEnv.dbUser &&
  awsEnv.dbName &&
  (awsEnv.dbIamAuthEnabled || awsEnv.dbPassword);

let mysqlPool: mysql.Pool | null = null;
let mysqlPoolTokenExpiresAt = 0;
const MYSQL_SSL_OPTIONS = { minVersion: 'TLSv1.2', rejectUnauthorized: true } as const;

const pool = usesMysql
  ? {
      execute: <T extends mysql.QueryResult>(sql: string, values?: any) =>
        withMysqlPool((activePool) => activePool.execute<T>(sql, values)),
      query: <T extends mysql.QueryResult>(sql: string, values?: any) =>
        withMysqlPool((activePool) => activePool.query<T>(sql, values)),
      getConnection: () => withMysqlPool((activePool) => activePool.getConnection()),
      end: async () => {
        if (mysqlPool) {
          await mysqlPool.end();
          mysqlPool = null;
          mysqlPoolTokenExpiresAt = 0;
        }
      },
    }
  : null;

async function withMysqlPool<T>(callback: (activePool: mysql.Pool) => Promise<T>) {
  const activePool = await getMysqlPool();
  if (!activePool) {
    throw new Error('MySQL pool is not configured.');
  }
  return callback(activePool);
}

async function getMysqlPool() {
  if (!usesMysql || !awsEnv.dbHost || !awsEnv.dbUser || !awsEnv.dbName) {
    return null;
  }

  const now = Date.now();
  if (mysqlPool && (!awsEnv.dbIamAuthEnabled || now < mysqlPoolTokenExpiresAt)) {
    return mysqlPool;
  }

  if (mysqlPool) {
    await mysqlPool.end();
    mysqlPool = null;
  }

  const password = awsEnv.dbIamAuthEnabled ? await buildIamAuthToken() : awsEnv.dbPassword;
  if (!password) {
    throw new Error('MySQL authentication is not configured.');
  }

  mysqlPool = mysql.createPool({
    host: awsEnv.dbHost,
    port: awsEnv.dbPort,
    user: awsEnv.dbUser,
    password,
    database: awsEnv.dbName,
    connectionLimit: 4,
    charset: 'utf8mb4',
    ssl: MYSQL_SSL_OPTIONS,
    authPlugins: awsEnv.dbIamAuthEnabled
      ? {
          mysql_clear_password: () => () => Buffer.from(`${password}\0`),
        }
      : undefined,
  });
  mysqlPoolTokenExpiresAt = awsEnv.dbIamAuthEnabled ? now + 14 * 60 * 1000 : Number.MAX_SAFE_INTEGER;
  return mysqlPool;
}

async function buildIamAuthToken() {
  if (!awsEnv.dbHost || !awsEnv.dbUser || !awsEnv.dbIamRegion) {
    throw new Error('IAM database authentication requires DB_HOST, DB_USER, and DB_IAM_REGION.');
  }

  const signer = new Signer({
    hostname: awsEnv.dbHost,
    port: awsEnv.dbPort,
    username: awsEnv.dbUser,
    region: awsEnv.dbIamRegion,
  });

  return signer.getAuthToken();
}

type StoredOrganisation = {
  id: number;
  name: string;
  isVatRegistered?: boolean;
  defaultTaxRateCosts?: string;
  billingPlan?: BillingPlanId;
  billingStatus?: BillingStatus;
  billingCycle?: BillingCycle;
  trialEndsAt?: string | null;
  monthlyDocumentLimit?: number | null;
  includedUsers?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  createdAt: string;
};

type StoredUser = {
  id: number;
  organisationId: number;
  email: string;
  passwordHash: string | null;
  fullName: string | null;
  role: UserRole;
  status: 'pending_invite' | 'active';
  inviteToken: string | null;
  invitedByUserId: number | null;
  createdAt: string;
};

type StoredClaim = ExpenseClaimRow;

export async function insertReceiptRecord(input: {
  organisationId: number;
  uploadedByUserId: number;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  claimId?: number | null;
  status?: ReceiptRow['status'];
  category?: string | null;
  description?: string | null;
  customer?: string | null;
  receiptSource?: ReceiptSource;
  sourceFileName: string;
  sourceMimeType: string;
  s3Bucket: string;
  s3Key: string;
  locale: string;
  extractionProvider: string;
  extractionModel: string;
  rawExtractionJson: unknown;
  document: NormalizedExpenseDocument;
}) {
  if (!pool) {
    const record = buildS3BackedReceiptRow(input);
    const metadataKey = buildReceiptMetadataKey(record);
    await putReceiptJsonObject(metadataKey, record);
    return record.id;
  }

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO receipts (
      organisation_id,
      uploaded_by_user_id,
      workspace_context,
      payment_method,
      claim_id,
      status,
      category,
      description,
      customer_name,
      receipt_source,
      source_filename,
      source_mime_type,
      s3_bucket,
      s3_key,
      locale,
      document_type,
      vendor_name,
      invoice_date,
      due_date,
      invoice_number,
      currency,
      total_amount,
      net_amount,
      vat_amount,
      tax_rate_applied,
      subtotal_amount,
      total_tax_amount,
      confidence_score,
      confidence_source,
      needs_review,
      extraction_provider,
      extraction_model,
      line_items,
      tax_breakdown,
      notes,
      raw_text_summary,
      raw_extraction_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.organisationId,
      input.uploadedByUserId,
      input.workspaceContext,
      input.paymentMethod,
      input.claimId ?? null,
      input.status ?? (input.document.needsReview ? 'Review' : 'Ready'),
      input.category ?? 'Uncategorised',
      input.description ?? null,
      input.customer ?? null,
      input.receiptSource ?? 'web_upload',
      input.sourceFileName,
      input.sourceMimeType,
      input.s3Bucket,
      input.s3Key,
      input.locale,
      input.document.documentType,
      input.document.vendorName,
      input.document.invoiceDate,
      input.document.dueDate,
      input.document.invoiceNumber,
      input.document.currency,
      input.document.totalAmount,
      input.document.netAmount,
      input.document.vatAmount,
      input.document.taxRateApplied,
      input.document.subtotalAmount,
      input.document.totalTaxAmount,
      input.document.confidenceScore,
      input.document.confidenceSource,
      input.document.needsReview ? 1 : 0,
      input.extractionProvider,
      input.extractionModel,
      JSON.stringify(input.document.lineItems),
      JSON.stringify(input.document.taxBreakdown),
      JSON.stringify(input.document.notes),
      input.document.rawTextSummary,
      JSON.stringify(input.rawExtractionJson),
    ],
  );

  return result.insertId;
}

export async function findDuplicateReceiptForOrganisation(input: {
  organisationId: number;
  workspaceContext: WorkspaceContext;
  document: NormalizedExpenseDocument;
  sourceFileName: string;
}) {
  const candidateKeys = buildDuplicateCandidateKeys({
    workspaceContext: input.workspaceContext,
    sourceFilename: input.sourceFileName,
    vendorName: input.document.vendorName,
    invoiceDate: input.document.invoiceDate,
    createdAt: new Date().toISOString(),
    totalAmount: input.document.totalAmount,
    netAmount: input.document.netAmount,
    vatAmount: input.document.vatAmount,
  });
  if (!candidateKeys.length) {
    return null;
  }

  const receipts = !pool
    ? await listOrganisationWorkspaceReceiptsFromS3(input.organisationId, input.workspaceContext, 1000)
    : await listOrganisationWorkspaceReceiptsFromMysql(input.organisationId, input.workspaceContext, 1000);

  return (
    receipts.find((receipt) => {
      const existingKeys = buildDuplicateCandidateKeys(receipt);
      return existingKeys.some((key) => candidateKeys.includes(key));
    }) ?? null
  );
}

export async function listReceipts(
  user: AuthenticatedUser,
  options?: {
    workspaceContext?: WorkspaceContext;
    onlyClaimable?: boolean;
    claimId?: number;
    limit?: number;
  },
): Promise<ReceiptRow[]> {
  const limit = options?.limit ?? 50;
  const workspaceContext = options?.workspaceContext ?? null;
  const onlyClaimable = options?.onlyClaimable ?? false;
  const claimId = options?.claimId ?? null;

  if (!pool) {
    const prefix = buildReceiptListPrefix(user, workspaceContext);
    const keys = await listReceiptJsonKeys(prefix, Math.max(limit * 4, 50));
    const receipts = await Promise.all(keys.map((key) => getReceiptJsonObject<ReceiptRow>(key)));
    return receipts
      .filter((receipt) => filterReceiptForUser(receipt, user))
      .filter((receipt) => (workspaceContext ? receipt.workspaceContext === workspaceContext : true))
      .filter((receipt) =>
        onlyClaimable
          ? receipt.workspaceContext === 'cost' &&
            receipt.paymentMethod === 'cash_personal' &&
            receipt.claimId === null
          : true,
      )
      .filter((receipt) => (claimId !== null ? receipt.claimId === claimId : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);
  }

  const params: Array<string | number | null> = [user.organisationId, user.role, user.id];
  const where = ['organisation_id = ?', "(? = 'Business_Admin' OR uploaded_by_user_id = ?)"];

  if (workspaceContext) {
    where.push('workspace_context = ?');
    params.push(workspaceContext);
  }
  if (onlyClaimable) {
    where.push("workspace_context = 'cost'");
    where.push("payment_method = 'cash_personal'");
    where.push('claim_id IS NULL');
  }
  if (claimId !== null) {
    where.push('claim_id = ?');
    params.push(claimId);
  }
  params.push(limit);

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      id,
      organisation_id,
      uploaded_by_user_id,
      workspace_context,
      payment_method,
      claim_id,
      status,
      category,
      description,
      customer_name,
      receipt_source,
      source_filename,
      source_mime_type,
      s3_bucket,
      s3_key,
      locale,
      document_type,
      vendor_name,
      invoice_date,
      due_date,
      invoice_number,
      currency,
      total_amount,
      net_amount,
      vat_amount,
      tax_rate_applied,
      subtotal_amount,
      total_tax_amount,
      confidence_score,
      confidence_source,
      needs_review,
      extraction_provider,
      extraction_model,
      line_items,
      tax_breakdown,
      notes,
      raw_text_summary,
      created_at,
      updated_at
    FROM receipts
    WHERE ${where.join(' AND ')}
    ORDER BY created_at DESC
    LIMIT ?`,
    params,
  );

  return rows.map(mapReceiptRow);
}

export async function createExpenseClaim(input: {
  organisationId: number;
  createdByUserId: number;
  name: string;
  description?: string | null;
  currency?: string | null;
}): Promise<ExpenseClaimRow> {
  const name = sanitizeText(input.name);
  if (!name) {
    throw validationError('Claim name is required.');
  }

  const claim: ExpenseClaimRow = {
    id: Date.now() + Math.floor(Math.random() * 1000),
    organisationId: input.organisationId,
    createdByUserId: input.createdByUserId,
    name,
    description: sanitizeText(input.description) || null,
    currency: sanitizeText(input.currency) || 'GBP',
    status: 'pending',
    totalAmount: 0,
    documentCount: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (!pool) {
    await putReceiptJsonObject(buildClaimKey(claim), claim);
    return claim;
  }

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO expense_claims (organisation_id, created_by_user_id, name, description, currency, status)
     VALUES (?, ?, ?, ?, ?, 'pending')`,
    [input.organisationId, input.createdByUserId, claim.name, claim.description, claim.currency],
  );

  return {
    ...claim,
    id: result.insertId,
  };
}

export async function listExpenseClaims(user: AuthenticatedUser, limit = 50): Promise<ExpenseClaimRow[]> {
  if (!pool) {
    const prefix =
      user.role === 'Business_Admin'
        ? `expense-claims/org-${user.organisationId}/`
        : `expense-claims/org-${user.organisationId}/user-${user.id}/`;
    const keys = await listReceiptJsonKeys(prefix, Math.max(limit * 3, 50));
    const claims = await Promise.all(keys.map((key) => getReceiptJsonObject<StoredClaim>(key)));
    const relevantClaims = claims
      .filter((claim) => claim.organisationId === user.organisationId)
      .filter((claim) => (user.role === 'Business_Admin' ? true : claim.createdByUserId === user.id))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);

    const allReceipts = await listReceipts(user, { limit: 500 });
    return relevantClaims.map((claim) => hydrateClaimTotals(claim, allReceipts));
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      c.id,
      c.organisation_id,
      c.created_by_user_id,
      c.name,
      c.description,
      c.currency,
      c.status,
      c.created_at,
      c.updated_at,
      COUNT(r.id) AS document_count,
      COALESCE(SUM(r.total_amount), 0) AS total_amount
    FROM expense_claims c
    LEFT JOIN receipts r ON r.claim_id = c.id
    WHERE c.organisation_id = ?
      AND (? = 'Business_Admin' OR c.created_by_user_id = ?)
    GROUP BY c.id
    ORDER BY c.created_at DESC
    LIMIT ?`,
    [user.organisationId, user.role, user.id, limit],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    createdByUserId: Number(row.created_by_user_id),
    name: String(row.name),
    description: row.description ? String(row.description) : null,
    currency: String(row.currency),
    status: String(row.status) as ExpenseClaimRow['status'],
    totalAmount: Number(row.total_amount ?? 0),
    documentCount: Number(row.document_count ?? 0),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function attachReceiptToClaim(input: {
  user: AuthenticatedUser;
  receiptId: number;
  claimId: number;
}): Promise<ReceiptRow> {
  if (!pool) {
    const receipts = await listReceipts(input.user, { limit: 500 });
    const target = receipts.find((receipt) => receipt.id === input.receiptId);
    if (!target) {
      throw notFoundError('Receipt not found.');
    }
    validateClaimableReceipt(target, input.user);

    const updated = {
      ...target,
      claimId: input.claimId,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildReceiptMetadataKey(updated), updated);
    return updated;
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      id,
      organisation_id,
      uploaded_by_user_id,
      workspace_context,
      payment_method,
      claim_id,
      status,
      category,
      description,
      customer_name,
      receipt_source,
      source_filename,
      source_mime_type,
      s3_bucket,
      s3_key,
      locale,
      document_type,
      vendor_name,
      invoice_date,
      due_date,
      invoice_number,
      currency,
      total_amount,
      net_amount,
      vat_amount,
      tax_rate_applied,
      subtotal_amount,
      total_tax_amount,
      confidence_score,
      confidence_source,
      needs_review,
      extraction_provider,
      extraction_model,
      line_items,
      tax_breakdown,
      notes,
      raw_text_summary,
      created_at,
      updated_at
     FROM receipts
     WHERE id = ? AND organisation_id = ? LIMIT 1`,
    [input.receiptId, input.user.organisationId],
  );
  const row = rows[0];
  if (!row) {
    throw notFoundError('Receipt not found.');
  }
  const receipt = mapReceiptRow(row);
  validateClaimableReceipt(receipt, input.user);

  await pool.execute(
    `UPDATE receipts SET claim_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [input.claimId, input.receiptId],
  );

  return {
    ...receipt,
    claimId: input.claimId,
    updatedAt: new Date().toISOString(),
  };
}

export async function createUser(input: {
  email: string;
  passwordHash: string;
  fullName?: string | null;
  organisationName?: string | null;
  billingPlan?: BillingPlanId | null;
  billingCycle?: BillingCycle | null;
  monthlyDocumentLimit?: number | null;
  includedUsers?: number | null;
}): Promise<AuthenticatedUser> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const organisationName = normalizeName(input.organisationName) || `${fullName || 'exdox'} Workspace`;
  const billingPlan = normalizePlanId(input.billingPlan);
  const billingCycle = normalizeBillingCycle(input.billingCycle);

  if (!pool) {
    const existing = await findUserByEmail(email);
    if (existing) {
      throw duplicateUserError();
    }

    const existingOrganisation = await findS3OrganisationByName(organisationName);
    if (existingOrganisation) {
      throw duplicateOrganisationError(existingOrganisation.name);
    }

    const organisation = await createS3Organisation(
      organisationName,
      billingPlan,
      billingCycle,
      input.monthlyDocumentLimit,
      input.includedUsers,
    );
    const user = buildStoredUser({
      id: Date.now(),
      organisationId: organisation.id,
      email,
      passwordHash: input.passwordHash,
      fullName,
      role: 'Business_Admin',
      status: 'active',
      inviteToken: null,
      invitedByUserId: null,
    });
    await putReceiptJsonObject(buildUserKey(email), user);
    return toAuthenticatedUser(user);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [existingOrgRows] = await connection.query<mysql.RowDataPacket[]>(
      `SELECT id, name
       FROM organisations
       WHERE LOWER(TRIM(name)) = ?
       LIMIT 1`,
      [normalizeOrganisationNameKey(organisationName)],
    );
    const existingOrganisation = existingOrgRows[0];
    if (existingOrganisation) {
      throw duplicateOrganisationError(String(existingOrganisation.name));
    }

    const [orgResult] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO organisations (
        name,
        billing_plan,
        billing_status,
        billing_cycle,
        trial_ends_at,
        monthly_document_limit,
        included_users
      ) VALUES (?, ?, 'trialing', ?, ?, ?, ?)`,
      [
        organisationName,
        billingPlan,
        billingCycle,
        defaultTrialEndsAt(billingPlan),
        input.monthlyDocumentLimit ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
        input.includedUsers ?? defaultIncludedUsersForPlan(billingPlan),
      ],
    );

    const [userResult] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO users (organisation_id, email, password_hash, full_name, user_role, status, invitation_accepted_at)
       VALUES (?, ?, ?, ?, 'Business_Admin', 'active', CURRENT_TIMESTAMP)`,
      [orgResult.insertId, email, input.passwordHash, fullName],
    );

    await connection.commit();
    return {
      id: userResult.insertId,
      organisationId: orgResult.insertId,
      email,
      fullName,
      role: 'Business_Admin',
      status: 'active',
    };
  } catch (error) {
    await connection.rollback();
    if (isDuplicateKeyError(error)) {
      throw duplicateUserError();
    }
    throw error;
  } finally {
    connection.release();
  }
}

export async function createInvite(input: {
  organisationId: number;
  invitedByUserId: number;
  email: string;
  fullName?: string | null;
  role?: UserRole;
}): Promise<{ invitedUser: UserRecord; organisationName: string; inviteLink: string }> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const role = input.role === 'Business_Admin' ? 'Business_Admin' : 'Standard_Employee';
  const inviteToken = crypto.randomBytes(24).toString('hex');

  if (!pool) {
    const existing = await findUserByEmail(email);
    if (existing) {
      throw duplicateUserError('An account or invite with this email already exists.');
    }

    const organisation = await getS3Organisation(input.organisationId);
    const user = buildStoredUser({
      id: Date.now(),
      organisationId: input.organisationId,
      email,
      passwordHash: null,
      fullName,
      role,
      status: 'pending_invite',
      inviteToken,
      invitedByUserId: input.invitedByUserId,
    });
    await putReceiptJsonObject(buildUserKey(email), user);
    return {
      invitedUser: toUserRecord(user),
      organisationName: organisation.name,
      inviteLink: buildInviteLink(inviteToken, email),
    };
  }

  const [existingRows] = await pool.query<mysql.RowDataPacket[]>(`SELECT id FROM users WHERE email = ? LIMIT 1`, [email]);
  if (existingRows[0]) {
    throw duplicateUserError('An account or invite with this email already exists.');
  }

  const [orgRows] = await pool.query<mysql.RowDataPacket[]>(`SELECT id, name FROM organisations WHERE id = ? LIMIT 1`, [
    input.organisationId,
  ]);
  const organisation = orgRows[0];
  if (!organisation) {
    throw new Error('Organisation not found for invite.');
  }

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO users (
      organisation_id,
      email,
      password_hash,
      full_name,
      user_role,
      status,
      invite_token,
      invited_by_user_id,
      invite_sent_at
    ) VALUES (?, ?, NULL, ?, ?, 'pending_invite', ?, ?, CURRENT_TIMESTAMP)`,
    [input.organisationId, email, fullName, role, inviteToken, input.invitedByUserId],
  );

  return {
    invitedUser: {
      id: result.insertId,
      organisationId: input.organisationId,
      email,
      fullName,
      role,
      status: 'pending_invite',
      passwordHash: null,
      inviteToken,
      invitedByUserId: input.invitedByUserId,
    },
    organisationName: String(organisation.name),
    inviteLink: buildInviteLink(inviteToken, email),
  };
}

export async function activateInvitedUser(input: {
  email: string;
  passwordHash: string;
  fullName?: string | null;
  inviteToken: string;
}): Promise<AuthenticatedUser> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const inviteToken = sanitizeText(input.inviteToken);

  if (!inviteToken) {
    throw invalidInviteError('An invite token is required to activate this account.');
  }

  if (!pool) {
    const existing = await findUserByEmail(email);
    if (!existing || existing.status !== 'pending_invite' || existing.inviteToken !== inviteToken) {
      throw invalidInviteError('This invite link is invalid or has already been used.');
    }

    const activated = buildStoredUser({
      id: existing.id,
      organisationId: existing.organisationId,
      email: existing.email,
      passwordHash: input.passwordHash,
      fullName: fullName || existing.fullName,
      role: existing.role,
      status: 'active',
      inviteToken: null,
      invitedByUserId: existing.invitedByUserId,
    });
    await putReceiptJsonObject(buildUserKey(email), activated);
    return toAuthenticatedUser(activated);
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, email, full_name, user_role AS role, status, invite_token
     FROM users
     WHERE email = ? LIMIT 1`,
    [email],
  );
  const row = rows[0];
  if (!row || String(row.status) !== 'pending_invite' || String(row.invite_token) !== inviteToken) {
    throw invalidInviteError('This invite link is invalid or has already been used.');
  }

  await pool.execute(
    `UPDATE users
     SET password_hash = ?, full_name = ?, status = 'active', invite_token = NULL, invitation_accepted_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [input.passwordHash, fullName || row.full_name || null, row.id],
  );

  return {
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    email: String(row.email),
    fullName: fullName || (row.full_name ? String(row.full_name) : null),
    role: normalizeUserRole(row.role),
    status: 'active',
  };
}

export async function findUserByEmail(emailInput: string): Promise<UserRecord | null> {
  const email = normalizeEmail(emailInput);

  if (!pool) {
    try {
      const user = await getReceiptJsonObject<StoredUser>(buildUserKey(email));
      return toUserRecord(user);
    } catch {
      return null;
    }
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      id,
      organisation_id,
      email,
      password_hash,
      full_name,
      user_role AS role,
      status,
      invite_token,
      invited_by_user_id
    FROM users
    WHERE email = ? LIMIT 1`,
    [email],
  );
  const row = rows[0];
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    email: String(row.email),
    passwordHash: row.password_hash ? String(row.password_hash) : null,
    fullName: row.full_name ? String(row.full_name) : null,
    role: normalizeUserRole(row.role),
    status: String(row.status) as UserRecord['status'],
    inviteToken: row.invite_token ? String(row.invite_token) : null,
    invitedByUserId: row.invited_by_user_id === null ? null : Number(row.invited_by_user_id),
  };
}

export async function getOrganisationName(organisationId: number) {
  if (!pool) {
    const organisation = await getS3Organisation(organisationId);
    return organisation.name;
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(`SELECT name FROM organisations WHERE id = ? LIMIT 1`, [
    organisationId,
  ]);
  const row = rows[0];
  if (!row) {
    throw new Error('Organisation not found.');
  }
  return String(row.name);
}

export async function getOrganisationTaxProfile(organisationId: number) {
  if (!pool) {
    try {
      const organisation = await getS3Organisation(organisationId);
      return {
        isVatRegistered: Boolean((organisation as StoredOrganisation & { isVatRegistered?: boolean }).isVatRegistered),
        defaultTaxRateCosts:
          (organisation as StoredOrganisation & { defaultTaxRateCosts?: string }).defaultTaxRateCosts || 'No VAT',
      };
    } catch {
      return {
        isVatRegistered: false,
        defaultTaxRateCosts: 'No VAT',
      };
    }
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT is_vat_registered, default_tax_rate_costs FROM organisations WHERE id = ? LIMIT 1`,
    [organisationId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error('Organisation not found.');
  }

  return {
    isVatRegistered: Boolean(row.is_vat_registered),
    defaultTaxRateCosts: row.default_tax_rate_costs ? String(row.default_tax_rate_costs) : 'No VAT',
  };
}

export async function getOrganisationSettings(organisationId: number): Promise<OrganisationSettings> {
  if (!pool) {
    const organisation = await getS3Organisation(organisationId);
    return {
      organisationId: organisation.id,
      organisationName: organisation.name,
      isVatRegistered: Boolean((organisation as StoredOrganisation & { isVatRegistered?: boolean }).isVatRegistered),
      defaultTaxRate:
        (organisation as StoredOrganisation & { defaultTaxRateCosts?: string }).defaultTaxRateCosts || 'No VAT',
    };
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, name, is_vat_registered, default_tax_rate_costs
     FROM organisations
     WHERE id = ?
     LIMIT 1`,
    [organisationId],
  );
  const row = rows[0];
  if (!row) {
    throw notFoundError('Organisation not found.');
  }

  return {
    organisationId: Number(row.id),
    organisationName: String(row.name),
    isVatRegistered: Boolean(row.is_vat_registered),
    defaultTaxRate: row.default_tax_rate_costs ? String(row.default_tax_rate_costs) : 'No VAT',
  };
}

export async function getOrganisationBillingSummary(organisationId: number): Promise<OrganisationBillingSummary> {
  if (!pool) {
    const organisation = await getS3Organisation(organisationId);
    const billingPlan = normalizePlanId(organisation.billingPlan);
    const users = await listS3UsersForOrganisation(organisationId);
    const monthlyDocumentUsage = await countS3DocumentsForCurrentMonth(organisationId);

    return {
      planId: billingPlan,
      status: normalizeBillingStatus(organisation.billingStatus, billingPlan),
      billingCycle: normalizeBillingCycle(organisation.billingCycle),
      trialEndsAt: organisation.trialEndsAt ?? defaultTrialEndsAt(billingPlan),
      monthlyDocumentLimit: normalizeNullableNumber(organisation.monthlyDocumentLimit) ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
      monthlyDocumentUsage,
      includedUsers: normalizeNullableNumber(organisation.includedUsers) ?? defaultIncludedUsersForPlan(billingPlan),
      currentUserCount: users.length,
      stripeCustomerId: organisation.stripeCustomerId ?? null,
      stripeSubscriptionId: organisation.stripeSubscriptionId ?? null,
    };
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      o.billing_plan,
      o.billing_status,
      o.billing_cycle,
      o.trial_ends_at,
      o.monthly_document_limit,
      o.included_users,
      o.stripe_customer_id,
      o.stripe_subscription_id,
      (
        SELECT COUNT(*)
        FROM receipts r
        WHERE r.organisation_id = o.id
          AND DATE_FORMAT(r.created_at, '%Y-%m') = DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m')
      ) AS monthly_document_usage,
      (
        SELECT COUNT(*)
        FROM users u
        WHERE u.organisation_id = o.id
      ) AS current_user_count
     FROM organisations o
     WHERE o.id = ?
     LIMIT 1`,
    [organisationId],
  );
  const row = rows[0];
  if (!row) {
    throw notFoundError('Organisation not found.');
  }

  const billingPlan = normalizePlanId(row.billing_plan);
  return {
    planId: billingPlan,
    status: normalizeBillingStatus(row.billing_status, billingPlan),
    billingCycle: normalizeBillingCycle(row.billing_cycle),
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : defaultTrialEndsAt(billingPlan),
    monthlyDocumentLimit: normalizeNullableNumber(row.monthly_document_limit) ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
    monthlyDocumentUsage: Number(row.monthly_document_usage ?? 0),
    includedUsers: normalizeNullableNumber(row.included_users) ?? defaultIncludedUsersForPlan(billingPlan),
    currentUserCount: Number(row.current_user_count ?? 0),
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
  };
}

export async function updateOrganisationSettings(input: {
  organisationId: number;
  isVatRegistered: boolean;
  defaultTaxRate: string;
}) {
  if (!pool) {
    const organisation = await getS3Organisation(input.organisationId);
    const next = {
      ...organisation,
      isVatRegistered: input.isVatRegistered,
      defaultTaxRateCosts: sanitizeText(input.defaultTaxRate) || 'No VAT',
    };
    await putReceiptJsonObject(buildOrganisationKey(input.organisationId), next);
    return getOrganisationSettings(input.organisationId);
  }

  await pool.execute(
    `UPDATE organisations
     SET is_vat_registered = ?, default_tax_rate_costs = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [input.isVatRegistered ? 1 : 0, sanitizeText(input.defaultTaxRate) || 'No VAT', input.organisationId],
  );

  return getOrganisationSettings(input.organisationId);
}

export async function updateOrganisationBillingProfile(input: {
  organisationId: number;
  billingPlan?: BillingPlanId;
  billingStatus?: BillingStatus;
  billingCycle?: BillingCycle;
  trialEndsAt?: string | null;
  monthlyDocumentLimit?: number | null;
  includedUsers?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
}) {
  if (!pool) {
    const organisation = await getS3Organisation(input.organisationId);
    const next: StoredOrganisation = {
      ...organisation,
      billingPlan: input.billingPlan ?? organisation.billingPlan ?? 'legacy',
      billingStatus: input.billingStatus ?? organisation.billingStatus ?? 'legacy',
      billingCycle: input.billingCycle ?? organisation.billingCycle ?? 'monthly',
      trialEndsAt: input.trialEndsAt === undefined ? organisation.trialEndsAt ?? null : input.trialEndsAt,
      monthlyDocumentLimit:
        input.monthlyDocumentLimit === undefined ? organisation.monthlyDocumentLimit ?? null : input.monthlyDocumentLimit,
      includedUsers: input.includedUsers === undefined ? organisation.includedUsers ?? null : input.includedUsers,
      stripeCustomerId:
        input.stripeCustomerId === undefined ? organisation.stripeCustomerId ?? null : input.stripeCustomerId,
      stripeSubscriptionId:
        input.stripeSubscriptionId === undefined
          ? organisation.stripeSubscriptionId ?? null
          : input.stripeSubscriptionId,
    };
    await putReceiptJsonObject(buildOrganisationKey(input.organisationId), next);
    return getOrganisationBillingSummary(input.organisationId);
  }

  await pool.execute(
    `UPDATE organisations
     SET billing_plan = COALESCE(?, billing_plan),
         billing_status = COALESCE(?, billing_status),
         billing_cycle = COALESCE(?, billing_cycle),
         trial_ends_at = COALESCE(?, trial_ends_at),
         monthly_document_limit = COALESCE(?, monthly_document_limit),
         included_users = COALESCE(?, included_users),
         stripe_customer_id = COALESCE(?, stripe_customer_id),
         stripe_subscription_id = COALESCE(?, stripe_subscription_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      input.billingPlan ?? null,
      input.billingStatus ?? null,
      input.billingCycle ?? null,
      input.trialEndsAt ?? null,
      input.monthlyDocumentLimit ?? null,
      input.includedUsers ?? null,
      input.stripeCustomerId ?? null,
      input.stripeSubscriptionId ?? null,
      input.organisationId,
    ],
  );

  return getOrganisationBillingSummary(input.organisationId);
}

export async function getReceiptById(user: AuthenticatedUser, receiptId: number): Promise<ReceiptRow> {
  const receipts = await listReceipts(user, { limit: 500 });
  const receipt = receipts.find((candidate) => candidate.id === receiptId);
  if (!receipt) {
    throw notFoundError('Receipt not found.');
  }
  return receipt;
}

export async function updateReceiptById(
  user: AuthenticatedUser,
  receiptId: number,
  updates: Partial<
    Pick<ReceiptRow, 'vendorName' | 'invoiceDate' | 'dueDate' | 'invoiceNumber' | 'category' | 'description' | 'customer' | 'netAmount' | 'vatAmount' | 'totalAmount' | 'taxRateApplied' | 'status'>
  >,
) {
  if (!pool) {
    const existing = await getReceiptById(user, receiptId);
    const next = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildReceiptMetadataKey(next), next);
    return next;
  }

  await pool.execute(
    `UPDATE receipts
     SET vendor_name = ?,
         invoice_date = ?,
         due_date = ?,
         invoice_number = ?,
         category = ?,
         description = ?,
         customer_name = ?,
         net_amount = ?,
         vat_amount = ?,
         total_amount = ?,
         tax_rate_applied = ?,
         status = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ?`,
    [
      updates.vendorName ?? null,
      updates.invoiceDate ?? null,
      updates.dueDate ?? null,
      updates.invoiceNumber ?? null,
      updates.category ?? null,
      updates.description ?? null,
      updates.customer ?? null,
      updates.netAmount ?? null,
      updates.vatAmount ?? null,
      updates.totalAmount ?? null,
      updates.taxRateApplied ?? null,
      updates.status ?? 'Review',
      receiptId,
      user.organisationId,
    ],
  );

  return getReceiptById(user, receiptId);
}

export async function deleteReceiptById(user: AuthenticatedUser, receiptId: number) {
  if (!pool) {
    const existing = await getReceiptById(user, receiptId);
    await putReceiptJsonObject(`deleted/${existing.id}-${Date.now()}.json`, existing);
    await Promise.all([
      deleteReceiptObject(buildReceiptMetadataKey(existing)),
      deleteReceiptObject(existing.s3Key),
    ]);
    return { success: true };
  }

  await pool.execute(`DELETE FROM receipts WHERE id = ? AND organisation_id = ?`, [receiptId, user.organisationId]);
  return { success: true };
}

export async function listReceiptsByClaim(user: AuthenticatedUser, claimId: number) {
  return listReceipts(user, { claimId, limit: 200 });
}

export async function updateClaimStatus(user: AuthenticatedUser, claimId: number, status: ExpenseClaimRow['status']) {
  if (!pool) {
    const claims = await listExpenseClaims(user, 200);
    const claim = claims.find((candidate) => candidate.id === claimId);
    if (!claim) {
      throw notFoundError('Claim not found.');
    }
    const nextClaim: ExpenseClaimRow = {
      ...claim,
      status,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildClaimKey(nextClaim), nextClaim);
    return hydrateClaimTotals(nextClaim, await listReceipts(user, { limit: 500 }));
  }

  await pool.execute(
    `UPDATE expense_claims
     SET status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ?`,
    [status, claimId, user.organisationId],
  );

  const claims = await listExpenseClaims(user, 200);
  const claim = claims.find((candidate) => candidate.id === claimId);
  if (!claim) {
    throw notFoundError('Claim not found.');
  }
  return claim;
}

export async function listSupplierRules(organisationId: number): Promise<SupplierRuleRow[]> {
  if (!pool) {
    const keys = await listReceiptJsonKeys(`supplier-rules/org-${organisationId}/`, 500);
    const rules = await Promise.all(keys.map((key) => getReceiptJsonObject<SupplierRuleRow>(key)));
    return rules
      .filter((rule) => rule.organisationId === organisationId)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, supplier_match_text, category, tax_rate, payment_method, is_active, created_at, updated_at
     FROM supplier_rules
     WHERE organisation_id = ?
     ORDER BY updated_at DESC`,
    [organisationId],
  );

  return rows.map((row) => ({
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    supplierMatchText: String(row.supplier_match_text),
    category: String(row.category),
    taxRate: String(row.tax_rate),
    paymentMethod: String(row.payment_method) as PaymentMethod,
    isActive: Boolean(row.is_active),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function applySupplierRulesToDocument(input: {
  organisationId: number;
  document: NormalizedExpenseDocument;
  paymentMethod: PaymentMethod;
}) {
  const rules = await listSupplierRules(input.organisationId);
  const vendor = sanitizeText(input.document.vendorName).toLowerCase();
  const matchedRule = rules.find(
    (rule) => rule.isActive && vendor && vendor.includes(rule.supplierMatchText.trim().toLowerCase()),
  );

  if (!matchedRule) {
    return {
      document: input.document,
      paymentMethod: input.paymentMethod,
      matchedRuleId: null,
      category: 'Uncategorised',
    };
  }

  return {
    document: {
      ...input.document,
      taxRateApplied: matchedRule.taxRate,
      notes: [...input.document.notes, `Supplier rule matched: ${matchedRule.supplierMatchText}`],
    },
    paymentMethod: matchedRule.paymentMethod,
    matchedRuleId: matchedRule.id,
    category: matchedRule.category,
  };
}

export async function upsertSupplierRule(input: Omit<SupplierRuleRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }) {
  if (!pool) {
    const existingRules = await listSupplierRules(input.organisationId);
    const existing = input.id ? existingRules.find((rule) => rule.id === input.id) : null;
    if (input.id && !existing) {
      throw notFoundError('Supplier rule not found.');
    }
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const nextRule: SupplierRuleRow = {
      id: existing?.id ?? Date.now() + Math.floor(Math.random() * 1000),
      organisationId: input.organisationId,
      supplierMatchText: sanitizeText(input.supplierMatchText),
      category: sanitizeText(input.category),
      taxRate: sanitizeText(input.taxRate) || '20% Standard',
      paymentMethod: input.paymentMethod,
      isActive: input.isActive,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildSupplierRuleKey(nextRule), nextRule);
    return nextRule;
  }

  if (input.id) {
    await pool.execute(
      `UPDATE supplier_rules
       SET supplier_match_text = ?, category = ?, tax_rate = ?, payment_method = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organisation_id = ?`,
      [
        sanitizeText(input.supplierMatchText),
        sanitizeText(input.category),
        sanitizeText(input.taxRate),
        input.paymentMethod,
        input.isActive ? 1 : 0,
        input.id,
        input.organisationId,
      ],
    );
  } else {
    await pool.execute(
      `INSERT INTO supplier_rules (organisation_id, supplier_match_text, category, tax_rate, payment_method, is_active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        input.organisationId,
        sanitizeText(input.supplierMatchText),
        sanitizeText(input.category),
        sanitizeText(input.taxRate),
        input.paymentMethod,
        input.isActive ? 1 : 0,
      ],
    );
  }

  const rules = await listSupplierRules(input.organisationId);
  return input.id ? rules.find((rule) => rule.id === input.id) ?? rules[0] : rules[0];
}

export async function deleteSupplierRule(organisationId: number, ruleId: number) {
  if (!pool) {
    const rules = await listSupplierRules(organisationId);
    const rule = rules.find((candidate) => candidate.id === ruleId);
    if (!rule) {
      throw notFoundError('Supplier rule not found.');
    }
    await deleteReceiptObject(buildSupplierRuleKey(rule));
    return { success: true };
  }
  await pool.execute(`DELETE FROM supplier_rules WHERE id = ? AND organisation_id = ?`, [ruleId, organisationId]);
  return { success: true };
}

export async function listBankTransactionsWithCandidates(
  organisationId: number,
): Promise<Array<BankTransactionRow & { candidates: ReconciliationCandidate[] }>> {
  if (!pool) {
    return [];
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, transaction_id, booking_date, remittance_information, transaction_amount, status, matched_receipt_id, created_at, updated_at
     FROM bank_transactions
     WHERE organisation_id = ?
     ORDER BY booking_date DESC, created_at DESC
     LIMIT 200`,
    [organisationId],
  );

  const [receiptRows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, invoice_date, vendor_name, total_amount, status, category, receipt_source
     FROM receipts
     WHERE organisation_id = ?
       AND workspace_context = 'cost'
     ORDER BY created_at DESC
     LIMIT 500`,
    [organisationId],
  );

  const receipts = receiptRows.map((row) => ({
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    invoiceDate: row.invoice_date ? new Date(row.invoice_date).toISOString().slice(0, 10) : null,
    vendorName: row.vendor_name ? String(row.vendor_name) : null,
    totalAmount: toDbNumber(row.total_amount),
    status: (row.status ? String(row.status) : 'Review') as ReceiptRow['status'],
    category: row.category ? String(row.category) : null,
    description: row.description ? String(row.description) : null,
    customer: row.customer_name ? String(row.customer_name) : null,
    receiptSource: (row.receipt_source ? String(row.receipt_source) : 'web_upload') as ReceiptRow['receiptSource'],
  }));

  return rows.map((row) => {
    const bookingDate = new Date(row.booking_date).toISOString().slice(0, 10);
    const transactionAmount = Number(row.transaction_amount);
    const candidates = receipts
      .filter((receipt) => receipt.totalAmount !== null)
      .map((receipt) => ({
        ...receipt,
        matchScore: buildReconciliationScore(bookingDate, transactionAmount, receipt.invoiceDate, receipt.totalAmount),
      }))
      .filter((receipt) => receipt.matchScore > 0)
      .sort((left, right) => right.matchScore - left.matchScore)
      .slice(0, 5);

    return {
      id: Number(row.id),
      organisationId: Number(row.organisation_id),
      transactionId: String(row.transaction_id),
      bookingDate,
      remittanceInformation: String(row.remittance_information),
      transactionAmount,
      status: String(row.status) as BankTransactionRow['status'],
      matchedReceiptId: row.matched_receipt_id === null ? null : Number(row.matched_receipt_id),
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      candidates,
    };
  });
}

export async function matchBankTransaction(input: {
  organisationId: number;
  bankTransactionId: number;
  receiptId: number;
}) {
  if (!pool) {
    throw validationError('Bank reconciliation requires MySQL mode.');
  }

  await pool.execute(
    `UPDATE bank_transactions
     SET matched_receipt_id = ?, status = 'Audited', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ?`,
    [input.receiptId, input.bankTransactionId, input.organisationId],
  );

  await pool.execute(
    `UPDATE receipts
     SET status = 'Published', updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ?`,
    [input.receiptId, input.organisationId],
  );

  return { success: true };
}

export async function createBankRequisition(input: {
  organisationId: number;
  provider: string;
  institutionId?: string | null;
}) {
  const callbackState = crypto.randomBytes(24).toString('hex');
  const externalRequisitionId = `req_${Date.now()}`;
  const redirectUrl = `${awsEnv.openBankingAuthUrl ?? 'https://console.truelayer.com'}/?provider=${encodeURIComponent(
    input.provider,
  )}&state=${encodeURIComponent(callbackState)}&redirect_uri=${encodeURIComponent(awsEnv.openBankingCallbackUrl)}`;

  if (!pool) {
    return {
      id: Date.now(),
      organisationId: input.organisationId,
      provider: input.provider,
      externalRequisitionId,
      institutionId: input.institutionId ?? null,
      status: 'pending',
      redirectUrl,
      callbackState,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies BankRequisitionRow;
  }

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO bank_requisitions (
      organisation_id,
      provider,
      external_requisition_id,
      institution_id,
      status,
      redirect_url,
      callback_state
    ) VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
    [input.organisationId, input.provider, externalRequisitionId, input.institutionId ?? null, redirectUrl, callbackState],
  );

  return {
    id: result.insertId,
    organisationId: input.organisationId,
    provider: input.provider,
    externalRequisitionId,
    institutionId: input.institutionId ?? null,
    status: 'pending',
    redirectUrl,
    callbackState,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } satisfies BankRequisitionRow;
}

export async function completeBankRequisition(input: {
  callbackState: string;
  externalRequisitionId?: string | null;
}) {
  if (!pool) {
    return { success: true };
  }

  await pool.execute(
    `UPDATE bank_requisitions
     SET status = 'linked',
         external_requisition_id = COALESCE(?, external_requisition_id),
         updated_at = CURRENT_TIMESTAMP
     WHERE callback_state = ?`,
    [input.externalRequisitionId ?? null, input.callbackState],
  );

  return { success: true };
}

export async function applySchema(sql: string) {
  if (!awsEnv.dbHost || !awsEnv.dbUser) {
    throw new Error('Database host and user are required to apply schema.');
  }

  const password = awsEnv.dbIamAuthEnabled ? await buildIamAuthToken() : awsEnv.dbPassword;
  if (!password) {
    throw new Error('Database authentication is required to apply schema.');
  }

  const connection = await mysql.createConnection({
    host: awsEnv.dbHost,
    port: awsEnv.dbPort,
    user: awsEnv.dbUser,
    password,
    ssl: MYSQL_SSL_OPTIONS,
    authPlugins: awsEnv.dbIamAuthEnabled
      ? {
          mysql_clear_password: () => () => Buffer.from(`${password}\0`),
        }
      : undefined,
    multipleStatements: true,
  });

  try {
    await connection.query(sql);
  } finally {
    await connection.end();
  }
}

function buildReceiptListPrefix(user: AuthenticatedUser, workspaceContext: WorkspaceContext | null) {
  if (user.role === 'Business_Admin') {
    return workspaceContext
      ? `receipt-records/org-${user.organisationId}/${workspaceContext}/`
      : `receipt-records/org-${user.organisationId}/`;
  }

  return workspaceContext
    ? `receipt-records/org-${user.organisationId}/${workspaceContext}/user-${user.id}/`
    : `receipt-records/org-${user.organisationId}/`;
}

async function listOrganisationWorkspaceReceiptsFromS3(
  organisationId: number,
  workspaceContext: WorkspaceContext,
  limit: number,
) {
  const prefix = `receipt-records/org-${organisationId}/${workspaceContext}/`;
  const keys = await listReceiptJsonKeys(prefix, Math.max(limit * 4, 50));
  const receipts = await Promise.all(keys.map((key) => getReceiptJsonObject<ReceiptRow>(key)));
  return receipts
    .filter((receipt) => receipt.organisationId === organisationId && receipt.workspaceContext === workspaceContext)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, limit);
}

async function listOrganisationWorkspaceReceiptsFromMysql(
  organisationId: number,
  workspaceContext: WorkspaceContext,
  limit: number,
) {
  const [rows] = await pool!.query<mysql.RowDataPacket[]>(
    `SELECT
      id,
      organisation_id,
      uploaded_by_user_id,
      workspace_context,
      payment_method,
      claim_id,
      status,
      category,
      description,
      customer_name,
      receipt_source,
      source_filename,
      source_mime_type,
      s3_bucket,
      s3_key,
      locale,
      document_type,
      vendor_name,
      invoice_date,
      due_date,
      invoice_number,
      currency,
      total_amount,
      net_amount,
      vat_amount,
      tax_rate_applied,
      subtotal_amount,
      total_tax_amount,
      confidence_score,
      confidence_source,
      needs_review,
      extraction_provider,
      extraction_model,
      line_items,
      tax_breakdown,
      notes,
      raw_text_summary,
      created_at,
      updated_at
    FROM receipts
    WHERE organisation_id = ? AND workspace_context = ?
    ORDER BY created_at DESC
    LIMIT ?`,
    [organisationId, workspaceContext, limit],
  );

  return rows.map(mapReceiptRow);
}

function filterReceiptForUser(receipt: ReceiptRow, user: AuthenticatedUser) {
  return user.role === 'Business_Admin'
    ? receipt.organisationId === user.organisationId
    : receipt.organisationId === user.organisationId && receipt.uploadedByUserId === user.id;
}

function hydrateClaimTotals(claim: StoredClaim, receipts: ReceiptRow[]): ExpenseClaimRow {
  const attached = receipts.filter((receipt) => receipt.claimId === claim.id);
  return {
    ...claim,
    totalAmount: attached.reduce((sum, receipt) => sum + (receipt.totalAmount ?? 0), 0),
    documentCount: attached.length,
  };
}

function validateClaimableReceipt(receipt: ReceiptRow, user: AuthenticatedUser) {
  if (!filterReceiptForUser(receipt, user)) {
    throw forbiddenError('You do not have access to this receipt.');
  }
  if (receipt.workspaceContext !== 'cost') {
    throw validationError('Only cost documents can be attached to an expense claim.');
  }
  if (receipt.paymentMethod !== 'cash_personal') {
    throw validationError('Only personal or cash spend can be attached to an expense claim.');
  }
  if (receipt.claimId !== null) {
    throw validationError('This receipt is already attached to a claim.');
  }
}

function safeJsonArrayParse(value: unknown) {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) {
    return value;
  }
  return [];
}

function mapReceiptRow(row: mysql.RowDataPacket): ReceiptRow {
  return {
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    uploadedByUserId: Number(row.uploaded_by_user_id),
    workspaceContext: String(row.workspace_context) as WorkspaceContext,
    paymentMethod: String(row.payment_method) as PaymentMethod,
    claimId: row.claim_id === null ? null : Number(row.claim_id),
    status: (row.status ? String(row.status) : 'Review') as ReceiptRow['status'],
    category: row.category ? String(row.category) : null,
    description: row.description ? String(row.description) : null,
    customer: row.customer_name ? String(row.customer_name) : null,
    receiptSource: (row.receipt_source ? String(row.receipt_source) : 'web_upload') as ReceiptRow['receiptSource'],
    sourceFilename: String(row.source_filename),
    sourceMimeType: String(row.source_mime_type),
    s3Bucket: String(row.s3_bucket),
    s3Key: String(row.s3_key),
    locale: String(row.locale),
    documentType: row.document_type,
    vendorName: row.vendor_name,
    invoiceDate: row.invoice_date ? new Date(row.invoice_date).toISOString().slice(0, 10) : null,
    dueDate: row.due_date ? new Date(row.due_date).toISOString().slice(0, 10) : null,
    invoiceNumber: row.invoice_number,
    currency: row.currency,
    totalAmount: toDbNumber(row.total_amount),
    netAmount: toDbNumber(row.net_amount) ?? toDbNumber(row.subtotal_amount),
    vatAmount: toDbNumber(row.vat_amount) ?? toDbNumber(row.total_tax_amount),
    taxRateApplied: row.tax_rate_applied ? String(row.tax_rate_applied) : null,
    subtotalAmount: toDbNumber(row.subtotal_amount),
    totalTaxAmount: toDbNumber(row.total_tax_amount),
    confidenceScore: toDbNumber(row.confidence_score),
    confidenceSource: row.confidence_source,
    needsReview: Boolean(row.needs_review),
    extractionProvider: String(row.extraction_provider),
    extractionModel: String(row.extraction_model),
    lineItems: safeJsonArrayParse(row.line_items),
    taxBreakdown: safeJsonArrayParse(row.tax_breakdown),
    notes: safeJsonArrayParse(row.notes),
    rawTextSummary: row.raw_text_summary,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function toDbNumber(value: unknown) {
  if (value === null || value === undefined) {
    return null;
  }
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : null;
}

function buildReconciliationScore(
  statementDate: string,
  statementAmount: number,
  receiptDate: string | null,
  receiptAmount: number | null,
) {
  if (receiptAmount === null) {
    return 0;
  }

  const amountDelta = Math.abs(statementAmount - receiptAmount);
  if (amountDelta > 0.01) {
    return 0;
  }

  if (!receiptDate) {
    return 0.5;
  }

  const left = new Date(statementDate);
  const right = new Date(receiptDate);
  const dayDistance = Math.abs(left.getTime() - right.getTime()) / (1000 * 60 * 60 * 24);
  if (dayDistance > 7) {
    return 0;
  }

  return Math.max(0.1, 1 - dayDistance / 7);
}

function buildDuplicateCandidateKeys(record: Pick<
  ReceiptRow,
  'workspaceContext' | 'sourceFilename' | 'vendorName' | 'invoiceDate' | 'createdAt' | 'totalAmount' | 'netAmount' | 'vatAmount'
>) {
  const amount = duplicateCandidateAmount(record);
  if (amount === null) {
    return [];
  }

  const date = duplicateCandidateDate(record);
  const baseParts = [record.workspaceContext, amount.toFixed(2), date];
  const vendor = normalizeDuplicateText(record.vendorName);
  const fileName = normalizeDuplicateText(record.sourceFilename.replace(/\.[a-z0-9]+$/i, ''));
  const keys: string[] = [];

  if (vendor) {
    keys.push(['vendor', vendor, ...baseParts].join('|'));
  }
  if (fileName) {
    keys.push(['file', fileName, ...baseParts].join('|'));
  }

  return keys;
}

function duplicateCandidateAmount(record: Pick<ReceiptRow, 'totalAmount' | 'netAmount' | 'vatAmount'>) {
  const hasComponentAmount = record.netAmount != null || record.vatAmount != null;
  const gross = record.totalAmount ?? (hasComponentAmount ? (record.netAmount ?? 0) + (record.vatAmount ?? 0) : null);
  return gross === null || !Number.isFinite(gross) || gross <= 0 ? null : gross;
}

function duplicateCandidateDate(record: Pick<ReceiptRow, 'invoiceDate' | 'createdAt'>) {
  return (record.invoiceDate ?? record.createdAt).slice(0, 10);
}

function normalizeDuplicateText(value: string | null | undefined) {
  return value?.trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() ?? '';
}

function buildS3BackedReceiptRow(input: {
  organisationId: number;
  uploadedByUserId: number;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  claimId?: number | null;
  status?: ReceiptRow['status'];
  category?: string | null;
  description?: string | null;
  customer?: string | null;
  receiptSource?: ReceiptSource;
  sourceFileName: string;
  sourceMimeType: string;
  s3Bucket: string;
  s3Key: string;
  locale: string;
  extractionProvider: string;
  extractionModel: string;
  rawExtractionJson: unknown;
  document: NormalizedExpenseDocument;
}): ReceiptRow {
  const createdAt = new Date().toISOString();
  const id = Date.now() + Math.floor(Math.random() * 1000);
  return {
    id,
    organisationId: input.organisationId,
    uploadedByUserId: input.uploadedByUserId,
    workspaceContext: input.workspaceContext,
    paymentMethod: input.paymentMethod,
    claimId: input.claimId ?? null,
    status: input.status ?? (input.document.needsReview ? 'Review' : 'Ready'),
    category: input.category ?? 'Uncategorised',
    description: input.description ?? null,
    customer: input.customer ?? null,
    receiptSource: input.receiptSource ?? 'web_upload',
    sourceFilename: input.sourceFileName,
    sourceMimeType: input.sourceMimeType,
    s3Bucket: input.s3Bucket,
    s3Key: input.s3Key,
    locale: input.locale,
    documentType: input.document.documentType,
    vendorName: input.document.vendorName,
    invoiceDate: input.document.invoiceDate,
    dueDate: input.document.dueDate,
    invoiceNumber: input.document.invoiceNumber,
    currency: input.document.currency,
    totalAmount: input.document.totalAmount,
    netAmount: input.document.netAmount,
    vatAmount: input.document.vatAmount,
    taxRateApplied: input.document.taxRateApplied,
    subtotalAmount: input.document.subtotalAmount,
    totalTaxAmount: input.document.totalTaxAmount,
    confidenceScore: input.document.confidenceScore,
    confidenceSource: input.document.confidenceSource,
    needsReview: input.document.needsReview,
    extractionProvider: input.extractionProvider,
    extractionModel: input.extractionModel,
    lineItems: input.document.lineItems,
    taxBreakdown: input.document.taxBreakdown,
    notes: input.document.notes,
    rawTextSummary: input.document.rawTextSummary,
    createdAt,
    updatedAt: createdAt,
  };
}

function buildReceiptMetadataKey(record: ReceiptRow) {
  const safeFileName = record.sourceFilename.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `receipt-records/org-${record.organisationId}/${record.workspaceContext}/user-${record.uploadedByUserId}/${record.createdAt.slice(0, 10)}/${record.id}-${safeFileName}.json`;
}

function buildClaimKey(claim: ExpenseClaimRow) {
  return `expense-claims/org-${claim.organisationId}/user-${claim.createdByUserId}/${claim.createdAt.slice(0, 10)}/${claim.id}.json`;
}

function buildSupplierRuleKey(rule: SupplierRuleRow) {
  return `supplier-rules/org-${rule.organisationId}/${rule.createdAt.slice(0, 10)}/${rule.id}.json`;
}

function buildUserKey(email: string) {
  return `users/${encodeURIComponent(normalizeEmail(email))}.json`;
}

function buildOrganisationKey(organisationId: number) {
  return `organisations/${organisationId}.json`;
}

async function createS3Organisation(
  name: string,
  billingPlan: BillingPlanId = 'legacy',
  billingCycle: BillingCycle = 'monthly',
  monthlyDocumentLimit?: number | null,
  includedUsers?: number | null,
): Promise<StoredOrganisation> {
  const organisation = {
    id: Date.now(),
    name,
    isVatRegistered: false,
    defaultTaxRateCosts: 'No VAT',
    billingPlan,
    billingStatus: (billingPlan === 'legacy' ? 'legacy' : 'trialing') as BillingStatus,
    billingCycle,
    trialEndsAt: defaultTrialEndsAt(billingPlan),
    monthlyDocumentLimit: monthlyDocumentLimit ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
    includedUsers: includedUsers ?? defaultIncludedUsersForPlan(billingPlan),
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    createdAt: new Date().toISOString(),
  };
  await putReceiptJsonObject(buildOrganisationKey(organisation.id), organisation);
  return organisation;
}

async function getS3Organisation(organisationId: number): Promise<StoredOrganisation> {
  return getReceiptJsonObject<StoredOrganisation>(buildOrganisationKey(organisationId));
}

async function listS3Organisations() {
  const keys = await listReceiptJsonKeys('organisations/', 500);
  return Promise.all(keys.map((key) => getReceiptJsonObject<StoredOrganisation>(key)));
}

async function findS3OrganisationByName(name: string) {
  const normalizedTarget = normalizeOrganisationNameKey(name);
  const organisations = await listS3Organisations();
  return (
    organisations.find((organisation) => normalizeOrganisationNameKey(organisation.name) === normalizedTarget) ?? null
  );
}

async function listS3UsersForOrganisation(organisationId: number) {
  const keys = await listReceiptJsonKeys('users/', 500);
  const users = await Promise.all(keys.map((key) => getReceiptJsonObject<StoredUser>(key)));
  return users.filter((user) => user.organisationId === organisationId);
}

async function countS3DocumentsForCurrentMonth(organisationId: number) {
  const prefix = `receipt-records/org-${organisationId}/`;
  const keys = await listReceiptJsonKeys(prefix, 2000);
  const monthPrefix = new Date().toISOString().slice(0, 7);
  return keys.filter((key) => key.includes(`/${monthPrefix}`)).length;
}

function defaultMonthlyDocumentLimitForPlan(planId: BillingPlanId) {
  switch (planId) {
    case 'capture':
      return 250;
    case 'control':
      return 2500;
    case 'operations':
      return 10000;
    default:
      return null;
  }
}

function defaultIncludedUsersForPlan(planId: BillingPlanId) {
  switch (planId) {
    case 'capture':
      return 5;
    case 'control':
      return 25;
    case 'operations':
      return 100;
    default:
      return null;
  }
}

function normalizeNullableNumber(value: unknown) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildStoredUser(input: Omit<StoredUser, 'createdAt'> & { createdAt?: string }): StoredUser {
  return {
    ...input,
    email: normalizeEmail(input.email),
    fullName: normalizeName(input.fullName),
    createdAt: input.createdAt || new Date().toISOString(),
  };
}

function toAuthenticatedUser(user: StoredUser | UserRecord): AuthenticatedUser {
  return {
    id: user.id,
    organisationId: user.organisationId,
    email: user.email,
    fullName: user.fullName,
    role: normalizeUserRole(user.role),
    status: user.status,
  };
}

function normalizeUserRole(role: unknown): UserRole {
  return role === 'Business_Admin' || role === 'Admin' ? 'Business_Admin' : 'Standard_Employee';
}

function toUserRecord(user: StoredUser): UserRecord {
  return {
    ...toAuthenticatedUser(user),
    passwordHash: user.passwordHash,
    inviteToken: user.inviteToken,
    invitedByUserId: user.invitedByUserId,
  };
}

function buildInviteLink(inviteToken: string, email: string) {
  const base = awsEnv.inviteBaseUrl.replace(/\/$/, '');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}inviteToken=${encodeURIComponent(inviteToken)}&email=${encodeURIComponent(email)}`;
}

function normalizeEmail(value: string) {
  return sanitizeText(value).toLowerCase();
}

function normalizeName(value: string | null | undefined) {
  const text = sanitizeText(value);
  return text || null;
}

function normalizeOrganisationNameKey(value: string | null | undefined) {
  const text = normalizeName(value)?.toLowerCase() || '';
  return text.replace(/\s+/g, ' ').trim();
}

function isDuplicateKeyError(error: unknown) {
  return Boolean(
    typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: string }).code === 'ER_DUP_ENTRY',
  );
}

function duplicateUserError(message = 'An account with this email already exists.') {
  const error = new Error(message) as Error & {
    statusCode?: number;
    code?: string;
  };
  error.statusCode = 409;
  error.code = 'user_exists';
  return error;
}

function duplicateOrganisationError(organisationName: string) {
  const error = new Error(
    `An organisation named "${organisationName}" already exists. Please sign in, ask an existing admin to invite you, or contact support if this business should be onboarded separately.`,
  ) as Error & {
    statusCode?: number;
    code?: string;
  };
  error.statusCode = 409;
  error.code = 'organisation_exists';
  return error;
}

export function duplicateReceiptError(message = 'Duplicate receipt detected.') {
  const error = new Error(message) as Error & {
    statusCode?: number;
    code?: string;
  };
  error.statusCode = 409;
  error.code = 'duplicate_receipt';
  return error;
}

function invalidInviteError(message: string) {
  const error = new Error(message) as Error & {
    statusCode?: number;
    code?: string;
  };
  error.statusCode = 400;
  error.code = 'invalid_invite';
  return error;
}

function notFoundError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 404;
  error.code = 'not_found';
  return error;
}

function forbiddenError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 403;
  error.code = 'forbidden';
  return error;
}

function validationError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 400;
  error.code = 'validation_error';
  return error;
}
