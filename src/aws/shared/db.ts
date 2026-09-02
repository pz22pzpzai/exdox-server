import crypto from 'node:crypto';

import { Signer } from '@aws-sdk/rds-signer';
import mysql from 'mysql2/promise';

import { awsEnv } from './env.js';
import { sanitizeText } from './helpers.js';
import {
  deleteReceiptObject,
  deleteReceiptPrefix,
  getReceiptJsonObject,
  listAllReceiptJsonKeys,
  listReceiptJsonKeys,
  putReceiptJsonObject,
} from './s3.js';
import {
  type AuthenticatedUser,
  type BankRequisitionRow,
  type BankTransactionRow,
  type BillingCycle,
  type BillingPlanId,
  type BillingStatus,
  type CompanyCardEmployeeExceptionRow,
  type CompanyCardRow,
  type DepartmentRow,
  type ExpenseClaimRow,
  type NormalizedExpenseDocument,
  type OrganisationBillingSummary,
  type OrganisationSettings,
  type PaymentMethod,
  type PaymentMethodMatchState,
  type ReconciliationCandidate,
  type ReceiptRow,
  type ReceiptSource,
  type SupplierRuleRow,
  type TeamMemberRow,
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
import { contentHashesMatch } from './contentHash.js';

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
  baseCurrency?: string;
  isVatRegistered?: boolean;
  defaultTaxRateCosts?: string;
  billingPlan?: BillingPlanId;
  billingStatus?: BillingStatus;
  billingCycle?: BillingCycle;
  trialEndsAt?: string | null;
  billingPeriodStartedAt?: string | null;
  billingPeriodEndsAt?: string | null;
  monthlyDocumentLimit?: number | null;
  includedUsers?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  cancellationScheduledFor?: string | null;
  createdAt: string;
};

type StoredUser = {
  id: number;
  organisationId: number;
  email: string;
  passwordHash: string | null;
  fullName: string | null;
  role: UserRole;
  status: 'pending_invite' | 'pending_confirmation' | 'active';
  inviteToken: string | null;
  invitedByUserId: number | null;
  departmentId?: number | null;
  createdAt: string;
  emailConfirmationGraceStartedAt?: string | null;
};

let teamSchemaReady: Promise<void> | null = null;
let receiptTaxTreatmentSchemaReady: Promise<void> | null = null;
let companyCardSchemaReady: Promise<void> | null = null;
let billingCycleSchemaReady: Promise<void> | null = null;
let expenseClaimMileageSchemaReady: Promise<void> | null = null;

async function ensureExpenseClaimMileageSchema() {
  if (!pool) {
    return;
  }
  expenseClaimMileageSchemaReady ??= (async () => {
    await pool.execute("ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS claim_type VARCHAR(24) NOT NULL DEFAULT 'standard' AFTER currency");
    await pool.execute('ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS mileage_start_postcode VARCHAR(24) NULL AFTER claim_type');
    await pool.execute('ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS mileage_end_postcode VARCHAR(24) NULL AFTER mileage_start_postcode');
    await pool.execute('ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS mileage_total_miles DECIMAL(10, 2) NULL AFTER mileage_end_postcode');
    await pool.execute('ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS mileage_rate DECIMAL(10, 4) NULL AFTER mileage_total_miles');
    await pool.execute('ALTER TABLE expense_claims ADD COLUMN IF NOT EXISTS mileage_total_amount DECIMAL(12, 2) NULL AFTER mileage_rate');
  })();
  await expenseClaimMileageSchemaReady;
}

async function ensureBillingCycleSchema() {
  if (!pool) {
    return;
  }
  billingCycleSchemaReady ??= (async () => {
    await pool.execute('ALTER TABLE organisations ADD COLUMN IF NOT EXISTS billing_period_started_at DATETIME NULL AFTER trial_ends_at');
    await pool.execute('ALTER TABLE organisations ADD COLUMN IF NOT EXISTS billing_period_ends_at DATETIME NULL AFTER billing_period_started_at');
  })();
  await billingCycleSchemaReady;
}

async function ensureTeamSchema() {
  if (!pool) {
    return;
  }
  teamSchemaReady ??= (async () => {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS departments (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organisation_id BIGINT UNSIGNED NOT NULL,
        name VARCHAR(120) NOT NULL,
        manager_user_id BIGINT UNSIGNED NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_departments_org_name (organisation_id, name),
        KEY idx_departments_org (organisation_id)
      )`,
    );
    await pool.execute('ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id BIGINT UNSIGNED NULL AFTER invited_by_user_id');
    await pool.execute('ALTER TABLE users ADD INDEX IF NOT EXISTS idx_users_org_department (organisation_id, department_id)');
  })();
  await teamSchemaReady;
}

async function ensureReceiptTaxTreatmentSchema() {
  if (!pool) {
    return;
  }
  receiptTaxTreatmentSchemaReady ??= (async () => {
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS foreign_tax_amount DECIMAL(12, 2) NULL AFTER total_tax_amount');
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS foreign_tax_label VARCHAR(120) NULL AFTER foreign_tax_amount');
    await pool.execute("ALTER TABLE receipts ADD COLUMN IF NOT EXISTS uk_vat_treatment VARCHAR(64) NOT NULL DEFAULT 'not_applicable' AFTER foreign_tax_label");
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS reimbursement_batch_id CHAR(36) NULL AFTER uk_vat_treatment');
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS reimbursement_batch_created_at DATETIME NULL AFTER reimbursement_batch_id');
  })();
  await receiptTaxTreatmentSchemaReady;
}

async function ensureCompanyCardSchema() {
  if (!pool) {
    return;
  }
  companyCardSchemaReady ??= (async () => {
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS company_cards (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organisation_id BIGINT UNSIGNED NOT NULL,
        label VARCHAR(120) NOT NULL,
        card_network VARCHAR(80) NULL,
        card_issuer VARCHAR(120) NULL,
        last_four CHAR(4) NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_company_cards_org_last_four (organisation_id, last_four),
        KEY idx_company_cards_org_active (organisation_id, is_active)
      )`,
    );
    await pool.execute(
      `CREATE TABLE IF NOT EXISTS company_card_employee_exceptions (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        organisation_id BIGINT UNSIGNED NOT NULL,
        company_card_id BIGINT UNSIGNED NOT NULL,
        employee_user_id BIGINT UNSIGNED NOT NULL,
        is_active TINYINT(1) NOT NULL DEFAULT 1,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_company_card_employee_exception (organisation_id, company_card_id, employee_user_id),
        KEY idx_company_card_exceptions_org_employee (organisation_id, employee_user_id)
      )`,
    );
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS detected_card_last_four CHAR(4) NULL AFTER invoice_number');
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS detected_card_network VARCHAR(80) NULL AFTER detected_card_last_four');
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS detected_card_issuer VARCHAR(120) NULL AFTER detected_card_network');
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS matched_company_card_id BIGINT UNSIGNED NULL AFTER payment_method');
    await pool.execute("ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method_match_state VARCHAR(32) NOT NULL DEFAULT 'not_detected' AFTER matched_company_card_id");
    await pool.execute('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method_review_required TINYINT(1) NOT NULL DEFAULT 0 AFTER payment_method_match_state');
  })();
  await companyCardSchemaReady;
}

type StoredClaim = ExpenseClaimRow;

export async function insertReceiptRecord(input: {
  organisationId: number;
  uploadedByUserId: number;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  paymentMethodMatchState?: PaymentMethodMatchState;
  paymentMethodReviewRequired?: boolean;
  matchedCompanyCardId?: number | null;
  claimId?: number | null;
  status?: ReceiptRow['status'];
  category?: string | null;
  description?: string | null;
  customer?: string | null;
  receiptSource?: ReceiptSource;
  sourceFileName: string;
  sourceMimeType: string;
  contentSha256?: string | null;
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

  await ensureReceiptTaxTreatmentSchema();
  await ensureCompanyCardSchema();

  const createdAt = new Date().toISOString();
  const fallbackInvoiceDate = normalizeReceiptDate(input.document.invoiceDate, createdAt);

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO receipts (
      organisation_id,
      uploaded_by_user_id,
      workspace_context,
      payment_method,
      matched_company_card_id,
      payment_method_match_state,
      payment_method_review_required,
      claim_id,
      status,
      category,
      description,
      customer_name,
      receipt_source,
      source_filename,
      source_mime_type,
      content_sha256,
      s3_bucket,
      s3_key,
      locale,
      document_type,
      vendor_name,
      invoice_date,
      due_date,
      invoice_number,
      detected_card_last_four,
      detected_card_network,
      detected_card_issuer,
      currency,
      total_amount,
      net_amount,
      vat_amount,
      tax_rate_applied,
      subtotal_amount,
      total_tax_amount,
      foreign_tax_amount,
      foreign_tax_label,
      uk_vat_treatment,
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
    [
      input.organisationId,
      input.uploadedByUserId,
      input.workspaceContext,
      input.paymentMethod,
      input.matchedCompanyCardId ?? null,
      input.paymentMethodMatchState ?? 'not_detected',
      input.paymentMethodReviewRequired ? 1 : 0,
      input.claimId ?? null,
      input.status ?? (input.document.needsReview ? 'Review' : 'Ready'),
      input.category ?? 'Uncategorised',
      input.description ?? null,
      input.customer ?? null,
      input.receiptSource ?? 'web_upload',
      input.sourceFileName,
      input.sourceMimeType,
      input.contentSha256 ?? null,
      input.s3Bucket,
      input.s3Key,
      input.locale,
      input.document.documentType,
      input.document.vendorName,
      fallbackInvoiceDate,
      input.document.dueDate,
      input.document.invoiceNumber,
      input.document.paymentCardLastFour,
      input.document.paymentCardNetwork,
      input.document.paymentCardIssuer,
      input.document.currency,
      input.document.totalAmount,
      input.document.netAmount,
      input.document.vatAmount,
      input.document.taxRateApplied,
      input.document.subtotalAmount,
      input.document.totalTaxAmount,
      input.document.foreignTaxAmount ?? null,
      input.document.foreignTaxLabel ?? null,
      input.document.ukVatTreatment ?? 'not_applicable',
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
  contentSha256?: string | null;
}) {
  const normalizedIncomingExactFileName = normalizeExactDuplicateFileName(input.sourceFileName);
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
      if (
        normalizedIncomingExactFileName &&
        normalizeExactDuplicateFileName(receipt.sourceFilename) === normalizedIncomingExactFileName
      ) {
        return true;
      }
      if (contentHashesMatch(input.contentSha256, receipt.contentSha256)) {
        return true;
      }
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
    const users = await listS3UsersForOrganisation(user.organisationId);
    const usersById = new Map(users.map((candidate) => [candidate.id, candidate]));
    return receipts
      .filter((receipt) => filterReceiptForUser(receipt, user))
      .filter((receipt) => (workspaceContext ? receipt.workspaceContext === workspaceContext : true))
      .filter((receipt) =>
        onlyClaimable
          ? receipt.workspaceContext === 'cost' &&
            receipt.paymentMethod === 'cash_personal' &&
            !receipt.paymentMethodReviewRequired &&
            receipt.claimId === null
          : true,
      )
      .filter((receipt) => (claimId !== null ? receipt.claimId === claimId : true))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((receipt) => {
        const uploader = usersById.get(receipt.uploadedByUserId);
        return {
          ...receipt,
          uploadedByName: uploader?.fullName ?? null,
          uploadedByEmail: uploader?.email ?? null,
        };
      });
  }

  await ensureTeamSchema();
  await ensureCompanyCardSchema();
  const params: Array<string | number | null> = [user.organisationId, user.role, user.id];
  const where = ['r.organisation_id = ?', "(? = 'Business_Admin' OR r.uploaded_by_user_id = ?)"];

  if (workspaceContext) {
    where.push('r.workspace_context = ?');
    params.push(workspaceContext);
  }
  if (onlyClaimable) {
    where.push("r.workspace_context = 'cost'");
    where.push("r.payment_method = 'cash_personal'");
    where.push('r.payment_method_review_required = 0');
    where.push('r.claim_id IS NULL');
  }
  if (claimId !== null) {
    where.push('r.claim_id = ?');
    params.push(claimId);
  }
  params.push(limit);

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      r.*,
      uploader.full_name AS uploaded_by_name,
      uploader.email AS uploaded_by_email,
      uploader.department_id AS uploaded_by_department_id,
      department.name AS uploaded_by_department_name
    FROM receipts r
    LEFT JOIN users uploader
      ON uploader.id = r.uploaded_by_user_id AND uploader.organisation_id = r.organisation_id
    LEFT JOIN departments department
      ON department.id = uploader.department_id AND department.organisation_id = r.organisation_id
    WHERE ${where.join(' AND ')}
    ORDER BY r.created_at DESC
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
  claimType?: 'standard' | 'mileage';
  mileageStartPostcode?: string | null;
  mileageEndPostcode?: string | null;
  mileageTotalMiles?: number | null;
  mileageRate?: number | null;
  mileageTotalAmount?: number | null;
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
    totalAmount: input.claimType === 'mileage' ? Number(input.mileageTotalAmount ?? 0) : 0,
    documentCount: 0,
    claimType: input.claimType === 'mileage' ? 'mileage' : 'standard',
    mileageStartPostcode: sanitizeText(input.mileageStartPostcode) || null,
    mileageEndPostcode: sanitizeText(input.mileageEndPostcode) || null,
    mileageTotalMiles: input.mileageTotalMiles ?? null,
    mileageRate: input.mileageRate ?? null,
    mileageTotalAmount: input.mileageTotalAmount ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (!pool) {
    await putReceiptJsonObject(buildClaimKey(claim), claim);
    return claim;
  }

  await ensureExpenseClaimMileageSchema();

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO expense_claims (
       organisation_id, created_by_user_id, name, description, currency, claim_type,
       mileage_start_postcode, mileage_end_postcode, mileage_total_miles, mileage_rate, mileage_total_amount, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      input.organisationId,
      input.createdByUserId,
      claim.name,
      claim.description,
      claim.currency,
      claim.claimType,
      claim.mileageStartPostcode,
      claim.mileageEndPostcode,
      claim.mileageTotalMiles,
      claim.mileageRate,
      claim.mileageTotalAmount,
    ],
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
    const emptyClaimCutoff = Date.now() - 10 * 60 * 1000;
    const emptyStandardClaims = claims.filter(
      (claim) =>
        claim.organisationId === user.organisationId &&
        claim.status === 'pending' &&
        claim.name.startsWith('Expense Claim') &&
        claim.totalAmount === 0 &&
        claim.documentCount === 0 &&
        claim.claimType !== 'mileage' &&
        new Date(claim.createdAt).getTime() < emptyClaimCutoff,
    );
    await Promise.all(emptyStandardClaims.map((claim) => deleteReceiptObject(buildClaimKey(claim))));

    const emptyClaimIds = new Set(emptyStandardClaims.map((claim) => claim.id));
    const relevantClaims = claims
      .filter((claim) => claim.organisationId === user.organisationId)
      .filter((claim) => (user.role === 'Business_Admin' ? true : claim.createdByUserId === user.id))
      .filter((claim) => !emptyClaimIds.has(claim.id))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit);

    const allReceipts = await listReceipts(user, { limit: 500 });
    const reconciledClaimStatuses = await reconcileReimbursementClaimStatuses(user, allReceipts);
    return Promise.all(relevantClaims.map(async (claim) => {
      const claimant = await findUserById(user.organisationId, claim.createdByUserId);
      const reconciledStatus = reconciledClaimStatuses.get(claim.id);
      const reconciledClaim = reconciledStatus
        ? { ...claim, status: reconciledStatus }
        : claim;
      return {
        ...hydrateClaimTotals(reconciledClaim, allReceipts),
        claimantName: claimant?.fullName ?? null,
        claimantEmail: claimant?.email ?? null,
      };
    }));
  }

  await ensureExpenseClaimMileageSchema();

  // Standard expense claims must have at least one attached receipt. Older
  // interrupted app flows could leave empty drafts behind, so remove them as
  // part of the normal read path instead of exposing £0.00 claims to users.
  await pool.execute(
    `DELETE FROM expense_claims
     WHERE organisation_id = ?
       AND (? = 'Business_Admin' OR created_by_user_id = ?)
       AND status = 'pending'
       AND name LIKE 'Expense Claim%'
       AND claim_type <> 'mileage'
       AND created_at < DATE_SUB(UTC_TIMESTAMP(), INTERVAL 10 MINUTE)
       AND NOT EXISTS (
         SELECT 1
         FROM receipts
         WHERE receipts.organisation_id = expense_claims.organisation_id
           AND receipts.claim_id = expense_claims.id
       )`,
    [user.organisationId, user.role, user.id],
  );

  await reconcileReimbursementClaimStatuses(user);
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      c.id,
      c.organisation_id,
      c.created_by_user_id,
      c.name,
      c.description,
      c.currency,
      c.claim_type,
      c.mileage_start_postcode,
      c.mileage_end_postcode,
      c.mileage_total_miles,
      c.mileage_rate,
      c.mileage_total_amount,
      c.status,
      c.created_at,
      c.updated_at,
      u.full_name AS claimant_name,
      u.email AS claimant_email,
      COUNT(r.id) AS document_count,
      CASE WHEN c.claim_type = 'mileage'
        THEN COALESCE(c.mileage_total_amount, 0)
        ELSE COALESCE(SUM(r.total_amount), 0)
      END AS total_amount
    FROM expense_claims c
    LEFT JOIN users u ON u.id = c.created_by_user_id AND u.organisation_id = c.organisation_id
    LEFT JOIN receipts r ON r.claim_id = c.id
    WHERE c.organisation_id = ?
      AND (? = 'Business_Admin' OR c.created_by_user_id = ?)
    GROUP BY c.id, c.currency, c.claim_type, c.mileage_start_postcode, c.mileage_end_postcode,
             c.mileage_total_miles, c.mileage_rate, c.mileage_total_amount, c.status,
             c.created_at, c.updated_at, u.full_name, u.email
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
    claimType: String(row.claim_type) === 'mileage' ? 'mileage' : 'standard',
    mileageStartPostcode: row.mileage_start_postcode ? String(row.mileage_start_postcode) : null,
    mileageEndPostcode: row.mileage_end_postcode ? String(row.mileage_end_postcode) : null,
    mileageTotalMiles: row.mileage_total_miles === null || row.mileage_total_miles === undefined ? null : Number(row.mileage_total_miles),
    mileageRate: row.mileage_rate === null || row.mileage_rate === undefined ? null : Number(row.mileage_rate),
    mileageTotalAmount: row.mileage_total_amount === null || row.mileage_total_amount === undefined ? null : Number(row.mileage_total_amount),
    claimantName: row.claimant_name ? String(row.claimant_name) : null,
    claimantEmail: row.claimant_email ? String(row.claimant_email) : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function attachReceiptToClaim(input: {
  user: AuthenticatedUser;
  receiptId: number;
  claimId: number;
}): Promise<ReceiptRow> {
  const targetClaim = await findExpenseClaimForAttachment(input.user, input.claimId);
  if (!targetClaim) {
    throw notFoundError('Expense claim not found.');
  }
  if (targetClaim.status === 'paid' || targetClaim.status === 'rejected') {
    throw validationError('Receipts cannot be attached to a paid or rejected claim.');
  }

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
      content_sha256,
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

async function findExpenseClaimForAttachment(
  user: AuthenticatedUser,
  claimId: number,
): Promise<Pick<ExpenseClaimRow, 'id' | 'status'> | null> {
  if (!pool) {
    const prefix =
      user.role === 'Business_Admin'
        ? `expense-claims/org-${user.organisationId}/`
        : `expense-claims/org-${user.organisationId}/user-${user.id}/`;
    const keys = await listReceiptJsonKeys(prefix, 1000);

    for (const key of keys) {
      const claim = await getReceiptJsonObject<StoredClaim>(key);
      if (
        claim.id === claimId &&
        claim.organisationId === user.organisationId &&
        (user.role === 'Business_Admin' || claim.createdByUserId === user.id)
      ) {
        return claim;
      }
    }
    return null;
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, status
     FROM expense_claims
     WHERE id = ?
       AND organisation_id = ?
       AND (? = 'Business_Admin' OR created_by_user_id = ?)
     LIMIT 1`,
    [claimId, user.organisationId, user.role, user.id],
  );
  const claim = rows[0];
  return claim
    ? { id: Number(claim.id), status: String(claim.status) as ExpenseClaimRow['status'] }
    : null;
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
}): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const organisationName = normalizeName(input.organisationName) || `${fullName || 'exdox'} Workspace`;
  const billingPlan = normalizePlanId(input.billingPlan);
  const billingCycle = normalizeBillingCycle(input.billingCycle);
  const initialBillingStatus = billingPlan === 'legacy' ? 'legacy' : 'inactive';
  const confirmationToken = crypto.randomBytes(24).toString('hex');

  if (!pool) {
    const existing = await findUserByEmail(email);
    if (existing) {
      throw duplicateUserError();
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
      status: 'pending_confirmation',
      inviteToken: confirmationToken,
      invitedByUserId: null,
    });
    await putReceiptJsonObject(buildUserKey(email), user);
    return toUserRecord(user);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [orgResult] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO organisations (
        name,
        is_vat_registered,
        default_tax_rate_costs,
        billing_plan,
        billing_status,
        billing_cycle,
        trial_ends_at,
        monthly_document_limit,
        included_users
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        organisationName,
        1,
        '20% Standard',
        billingPlan,
        initialBillingStatus,
        billingCycle,
        initialBillingStatus === 'inactive' ? null : defaultTrialEndsAt(billingPlan),
        input.monthlyDocumentLimit ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
        input.includedUsers ?? defaultIncludedUsersForPlan(billingPlan),
      ],
    );

    const [userResult] = await connection.execute<mysql.ResultSetHeader>(
      `INSERT INTO users (organisation_id, email, password_hash, full_name, user_role, status, invite_token)
       VALUES (?, ?, ?, ?, 'Business_Admin', 'pending_confirmation', ?)`,
      [orgResult.insertId, email, input.passwordHash, fullName, confirmationToken],
    );

    await connection.commit();
    return {
      id: userResult.insertId,
      organisationId: orgResult.insertId,
      email,
      passwordHash: input.passwordHash,
      fullName,
      role: 'Business_Admin',
      status: 'pending_confirmation',
      inviteToken: confirmationToken,
      invitedByUserId: null,
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

const PUBLIC_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'googlemail.com',
  'hotmail.co.uk',
  'hotmail.com',
  'icloud.com',
  'live.co.uk',
  'live.com',
  'mail.com',
  'outlook.co.uk',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.co.uk',
  'yahoo.com',
]);

export async function findConfirmedAdminOrganisationForEmailDomain(emailInput: string): Promise<{
  organisationId: number;
  organisationName: string;
} | null> {
  const domain = emailDomain(emailInput);
  if (!domain || PUBLIC_EMAIL_DOMAINS.has(domain)) {
    return null;
  }

  if (!pool) {
    const keys = await listReceiptJsonKeys('users/', 2000);
    const users = await Promise.all(keys.map((key) => getReceiptJsonObject<StoredUser>(key)));
    const organisationIds = [...new Set(
      users
        .filter((user) => user.role === 'Business_Admin' && user.status === 'active' && emailDomain(user.email) === domain)
        .map((user) => user.organisationId),
    )];

    if (organisationIds.length > 1) {
      throw domainConflictError();
    }
    if (!organisationIds[0]) {
      return null;
    }
    const organisation = await getS3Organisation(organisationIds[0]);
    return { organisationId: organisation.id, organisationName: organisation.name };
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT DISTINCT u.organisation_id, o.name AS organisation_name
     FROM users u
     INNER JOIN organisations o ON o.id = u.organisation_id
     WHERE u.user_role = 'Business_Admin'
       AND u.status = 'active'
       AND LOWER(SUBSTRING_INDEX(u.email, '@', -1)) = ?
     LIMIT 2`,
    [domain],
  );
  if (rows.length > 1) {
    throw domainConflictError();
  }
  const row = rows[0];
  return row
    ? { organisationId: Number(row.organisation_id), organisationName: String(row.organisation_name) }
    : null;
}

export async function createDomainEmployeeUser(input: {
  organisationId: number;
  email: string;
  passwordHash: string;
  fullName?: string | null;
}): Promise<UserRecord> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const confirmationToken = crypto.randomBytes(24).toString('hex');

  if (!pool) {
    if (await findUserByEmail(email)) {
      throw duplicateUserError();
    }
    const user = buildStoredUser({
      id: Date.now(),
      organisationId: input.organisationId,
      email,
      passwordHash: input.passwordHash,
      fullName,
      role: 'Standard_Employee',
      status: 'pending_confirmation',
      inviteToken: confirmationToken,
      invitedByUserId: null,
    });
    await putReceiptJsonObject(buildUserKey(email), user);
    return toUserRecord(user);
  }

  try {
    const [result] = await pool.execute<mysql.ResultSetHeader>(
      `INSERT INTO users (
        organisation_id, email, password_hash, full_name, user_role, status, invite_token, invited_by_user_id
      ) VALUES (?, ?, ?, ?, 'Standard_Employee', 'pending_confirmation', ?, NULL)`,
      [input.organisationId, email, input.passwordHash, fullName, confirmationToken],
    );
    return {
      id: result.insertId,
      organisationId: input.organisationId,
      email,
      passwordHash: input.passwordHash,
      fullName,
      role: 'Standard_Employee',
      status: 'pending_confirmation',
      inviteToken: confirmationToken,
      invitedByUserId: null,
    };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw duplicateUserError();
    }
    throw error;
  }
}

function confirmedRegistrationTokenMarker(confirmationToken: string) {
  return `confirmed:${crypto.createHash('sha256').update(confirmationToken).digest('hex')}`;
}

export async function confirmRegisteredUserEmail(input: {
  email: string;
  confirmationToken: string;
}): Promise<{ user: AuthenticatedUser; alreadyConfirmed: boolean }> {
  const email = normalizeEmail(input.email);
  const confirmationToken = sanitizeText(input.confirmationToken);

  if (!confirmationToken) {
    throw invalidInviteError('A confirmation token is required to activate this account.');
  }

  if (!pool) {
    const existing = await findUserByEmail(email);
    const confirmedTokenMarker = confirmedRegistrationTokenMarker(confirmationToken);
    if (existing?.status === 'active' && existing.inviteToken === confirmedTokenMarker) {
      return {
        user: toAuthenticatedUser(existing),
        alreadyConfirmed: true,
      };
    }
    if (!existing || existing.status !== 'pending_confirmation' || existing.inviteToken !== confirmationToken) {
      throw invalidInviteError('This confirmation link is invalid or has already been used.');
    }

    const activated = buildStoredUser({
      id: existing.id,
      organisationId: existing.organisationId,
      email: existing.email,
      passwordHash: existing.passwordHash,
      fullName: existing.fullName,
      role: existing.role,
      status: 'active',
      inviteToken: confirmedTokenMarker,
      invitedByUserId: existing.invitedByUserId,
      createdAt: existing.createdAt ?? undefined,
      emailConfirmationGraceStartedAt: null,
    });
    await putReceiptJsonObject(buildUserKey(email), activated);
    return {
      user: toAuthenticatedUser(activated),
      alreadyConfirmed: false,
    };
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, email, full_name, user_role AS role, status, invite_token
     FROM users
     WHERE email = ? LIMIT 1`,
    [email],
  );
  const row = rows[0];
  const confirmedTokenMarker = confirmedRegistrationTokenMarker(confirmationToken);
  if (row && String(row.status) === 'active' && String(row.invite_token) === confirmedTokenMarker) {
    return {
      user: {
        id: Number(row.id),
        organisationId: Number(row.organisation_id),
        email: String(row.email),
        fullName: row.full_name ? String(row.full_name) : null,
        role: normalizeUserRole(row.role),
        status: 'active',
      },
      alreadyConfirmed: true,
    };
  }
  if (!row || String(row.status) !== 'pending_confirmation' || String(row.invite_token) !== confirmationToken) {
    throw invalidInviteError('This confirmation link is invalid or has already been used.');
  }

  await pool.execute(
    `UPDATE users
     SET status = 'active', invite_token = ?, invitation_accepted_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [confirmedTokenMarker, row.id],
  );

  return {
    user: {
      id: Number(row.id),
      organisationId: Number(row.organisation_id),
      email: String(row.email),
      fullName: row.full_name ? String(row.full_name) : null,
      role: normalizeUserRole(row.role),
      status: 'active',
    },
    alreadyConfirmed: false,
  };
}

export async function createInvite(input: {
  organisationId: number;
  invitedByUserId: number;
  email: string;
  fullName?: string | null;
  role?: UserRole;
  departmentId?: number | null;
}): Promise<{ invitedUser: UserRecord; organisationName: string; inviteLink: string }> {
  const email = normalizeEmail(input.email);
  const fullName = normalizeName(input.fullName);
  const role = input.role === 'Business_Admin' ? 'Business_Admin' : 'Standard_Employee';
  const departmentId = input.departmentId ?? null;
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
      departmentId,
    });
    await putReceiptJsonObject(buildUserKey(email), user);
    return {
      invitedUser: toUserRecord(user),
      organisationName: organisation.name,
      inviteLink: buildInviteLink(inviteToken, email),
    };
  }

  await ensureTeamSchema();
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
       department_id,
       invite_sent_at
    ) VALUES (?, ?, NULL, ?, ?, 'pending_invite', ?, ?, ?, CURRENT_TIMESTAMP)`,
    [input.organisationId, email, fullName, role, inviteToken, input.invitedByUserId, departmentId],
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
      departmentId,
    },
    organisationName: String(organisation.name),
    inviteLink: buildInviteLink(inviteToken, email),
  };
}

export async function listDepartments(user: AuthenticatedUser): Promise<DepartmentRow[]> {
  if (!pool) {
    return [];
  }
  await ensureTeamSchema();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT d.id, d.organisation_id, d.name, d.manager_user_id, manager.full_name AS manager_name
     FROM departments d
     LEFT JOIN users manager ON manager.id = d.manager_user_id AND manager.organisation_id = d.organisation_id
     WHERE d.organisation_id = ?
     ORDER BY d.name ASC`,
    [user.organisationId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    name: String(row.name),
    managerUserId: row.manager_user_id === null ? null : Number(row.manager_user_id),
    managerName: row.manager_name ? String(row.manager_name) : null,
  }));
}

export async function createDepartment(user: AuthenticatedUser, name: string): Promise<DepartmentRow> {
  const normalizedName = sanitizeText(name);
  if (!normalizedName) {
    throw validationError('Enter a department name.');
  }
  if (!pool) {
    throw validationError('Department management requires the configured workspace database.');
  }
  await ensureTeamSchema();
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    'INSERT INTO departments (organisation_id, name) VALUES (?, ?)',
    [user.organisationId, normalizedName],
  );
  return { id: result.insertId, organisationId: user.organisationId, name: normalizedName, managerUserId: null, managerName: null };
}

export async function listTeamMembers(user: AuthenticatedUser): Promise<TeamMemberRow[]> {
  if (!pool) {
    return [];
  }
  await ensureTeamSchema();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT u.id, u.organisation_id, u.email, u.full_name, u.user_role, u.status, u.department_id, u.invited_by_user_id,
            d.name AS department_name
     FROM users u
     LEFT JOIN departments d ON d.id = u.department_id AND d.organisation_id = u.organisation_id
     WHERE u.organisation_id = ?
     ORDER BY u.full_name IS NULL, u.full_name ASC, u.email ASC`,
    [user.organisationId],
  );
  return rows.map((row) => ({
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    email: String(row.email),
    fullName: row.full_name ? String(row.full_name) : null,
    role: normalizeUserRole(row.user_role),
    status: String(row.status) as TeamMemberRow['status'],
    departmentId: row.department_id === null ? null : Number(row.department_id),
    departmentName: row.department_name ? String(row.department_name) : null,
    invitedByUserId: row.invited_by_user_id === null ? null : Number(row.invited_by_user_id),
  }));
}

export async function updateTeamMemberDepartment(user: AuthenticatedUser, userId: number, departmentId: number | null) {
  if (!pool) {
    throw validationError('Department management requires the configured workspace database.');
  }
  await ensureTeamSchema();
  if (departmentId !== null) {
    const [departmentRows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT id FROM departments WHERE id = ? AND organisation_id = ? LIMIT 1',
      [departmentId, user.organisationId],
    );
    if (!departmentRows[0]) {
      throw validationError('Choose a department in this workspace.');
    }
  }
  const [result] = await pool.execute<mysql.ResultSetHeader>(
    'UPDATE users SET department_id = ? WHERE id = ? AND organisation_id = ?',
    [departmentId, userId, user.organisationId],
  );
  if (!result.affectedRows) {
    throw notFoundError('Team member not found.');
  }
}

export async function isOrganisationOwner(user: AuthenticatedUser) {
  if (user.role !== 'Business_Admin') {
    return false;
  }
  const stored = await findUserById(user.organisationId, user.id);
  return Boolean(stored && stored.role === 'Business_Admin' && stored.invitedByUserId === null);
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
      invited_by_user_id,
      created_at
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
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function rotateRegistrationConfirmationToken(emailInput: string): Promise<UserRecord | null> {
  const email = normalizeEmail(emailInput);
  const existing = await findUserByEmail(email);
  if (!existing || existing.status !== 'pending_confirmation') {
    return null;
  }

  const confirmationToken = crypto.randomBytes(24).toString('hex');
  if (!pool) {
    const updated = buildStoredUser({
      id: existing.id,
      organisationId: existing.organisationId,
      email: existing.email,
      passwordHash: existing.passwordHash,
      fullName: existing.fullName,
      role: existing.role,
      status: existing.status,
      inviteToken: confirmationToken,
      invitedByUserId: existing.invitedByUserId,
      createdAt: existing.createdAt ?? undefined,
      emailConfirmationGraceStartedAt: existing.emailConfirmationGraceStartedAt ?? null,
    });
    await putReceiptJsonObject(buildUserKey(email), updated);
    return toUserRecord(updated);
  }

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE users
     SET invite_token = ?, invite_sent_at = CURRENT_TIMESTAMP
     WHERE id = ? AND status = 'pending_confirmation'`,
    [confirmationToken, existing.id],
  );
  if (!result.affectedRows) {
    return null;
  }

  return {
    ...existing,
    inviteToken: confirmationToken,
  };
}

export async function ensureEmailConfirmationGraceStarted(emailInput: string): Promise<UserRecord | null> {
  const email = normalizeEmail(emailInput);
  const existing = await findUserByEmail(email);
  if (!existing || existing.status !== 'pending_confirmation') {
    return existing;
  }
  if (existing.emailConfirmationGraceStartedAt) {
    return existing;
  }

  const startedAt = new Date().toISOString();
  if (!pool) {
    const updated = buildStoredUser({
      id: existing.id,
      organisationId: existing.organisationId,
      email: existing.email,
      passwordHash: existing.passwordHash,
      fullName: existing.fullName,
      role: existing.role,
      status: existing.status,
      inviteToken: existing.inviteToken,
      invitedByUserId: existing.invitedByUserId,
      createdAt: existing.createdAt ?? undefined,
      emailConfirmationGraceStartedAt: startedAt,
    });
    await putReceiptJsonObject(buildUserKey(email), updated);
    return toUserRecord(updated);
  }

  // The live service uses S3. The optional SQL store currently anchors this grace period to account creation.
  return {
    ...existing,
    emailConfirmationGraceStartedAt: existing.createdAt ?? startedAt,
  };
}

export async function updateUserPassword(input: {
  email: string;
  userId: number;
  passwordHash: string;
}): Promise<UserRecord> {
  const email = normalizeEmail(input.email);

  if (!pool) {
    const existing = await findUserByEmail(email);
    if (!existing || existing.id !== input.userId) {
      throw notFoundError('Account not found for this password reset request.');
    }

    const updated = buildStoredUser({
      id: existing.id,
      organisationId: existing.organisationId,
      email: existing.email,
      passwordHash: input.passwordHash,
      fullName: existing.fullName,
      role: existing.role,
      status: existing.status,
      inviteToken: existing.inviteToken,
      invitedByUserId: existing.invitedByUserId,
      createdAt: existing.createdAt ?? undefined,
      emailConfirmationGraceStartedAt: existing.emailConfirmationGraceStartedAt ?? null,
    });
    await putReceiptJsonObject(buildUserKey(email), updated);
    return toUserRecord(updated);
  }

  const [result] = await pool.execute<mysql.ResultSetHeader>(
    `UPDATE users
     SET password_hash = ?
     WHERE id = ? AND LOWER(TRIM(email)) = ?`,
    [input.passwordHash, input.userId, email],
  );

  if (!result.affectedRows) {
    throw notFoundError('Account not found for this password reset request.');
  }

  const updated = await findUserByEmail(email);
  if (!updated || updated.id !== input.userId) {
    throw notFoundError('Account not found for this password reset request.');
  }

  return updated;
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
        isVatRegistered: (organisation as StoredOrganisation & { isVatRegistered?: boolean }).isVatRegistered !== false,
        defaultTaxRateCosts:
          (organisation as StoredOrganisation & { defaultTaxRateCosts?: string }).defaultTaxRateCosts || '20% Standard',
      };
    } catch {
      return {
        isVatRegistered: true,
        defaultTaxRateCosts: '20% Standard',
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
    isVatRegistered: row.is_vat_registered == null ? true : Boolean(row.is_vat_registered),
    defaultTaxRateCosts: row.default_tax_rate_costs ? String(row.default_tax_rate_costs) : '20% Standard',
  };
}

export async function getOrganisationBaseCurrency(organisationId: number) {
  if (!pool) {
    const organisation = await getS3Organisation(organisationId);
    return organisation.baseCurrency?.trim().toUpperCase() || 'GBP';
  }
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    'SELECT base_currency FROM organisations WHERE id = ? LIMIT 1',
    [organisationId],
  );
  return rows[0]?.base_currency ? String(rows[0].base_currency).trim().toUpperCase() : 'GBP';
}

export async function getOrganisationSettings(organisationId: number): Promise<OrganisationSettings> {
  if (!pool) {
    const organisation = await getS3Organisation(organisationId);
    return {
      organisationId: organisation.id,
      organisationName: organisation.name,
      baseCurrency: organisation.baseCurrency?.trim().toUpperCase() || 'GBP',
      isVatRegistered: (organisation as StoredOrganisation & { isVatRegistered?: boolean }).isVatRegistered !== false,
      defaultTaxRate:
        (organisation as StoredOrganisation & { defaultTaxRateCosts?: string }).defaultTaxRateCosts || '20% Standard',
    };
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, name, base_currency, is_vat_registered, default_tax_rate_costs
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
    baseCurrency: row.base_currency ? String(row.base_currency).trim().toUpperCase() : 'GBP',
    isVatRegistered: row.is_vat_registered == null ? true : Boolean(row.is_vat_registered),
    defaultTaxRate: row.default_tax_rate_costs ? String(row.default_tax_rate_costs) : '20% Standard',
  };
}

export async function getOrganisationBillingSummary(organisationId: number): Promise<OrganisationBillingSummary> {
  if (!pool) {
    const organisation = await getS3Organisation(organisationId);
    const billingPlan = normalizePlanId(organisation.billingPlan);
    const users = await listS3UsersForOrganisation(organisationId);
    const billingPeriodStartedAt = organisation.billingPeriodStartedAt ?? defaultUsagePeriodStart();
    const monthlyDocumentUsage = await countS3DocumentsForBillingPeriod(organisationId, billingPeriodStartedAt);

    return {
      planId: billingPlan,
      status: normalizeBillingStatus(organisation.billingStatus, billingPlan),
      billingCycle: normalizeBillingCycle(organisation.billingCycle),
      trialEndsAt:
        organisation.trialEndsAt
        ?? (normalizeBillingStatus(organisation.billingStatus, billingPlan) === 'inactive' ? null : defaultTrialEndsAt(billingPlan)),
      billingPeriodStartedAt,
      billingPeriodEndsAt: organisation.billingPeriodEndsAt ?? null,
      monthlyDocumentLimit: normalizeNullableNumber(organisation.monthlyDocumentLimit) ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
      monthlyDocumentUsage,
      includedUsers: normalizeNullableNumber(organisation.includedUsers) ?? defaultIncludedUsersForPlan(billingPlan),
      currentUserCount: users.length,
      stripeCustomerId: organisation.stripeCustomerId ?? null,
      stripeSubscriptionId: organisation.stripeSubscriptionId ?? null,
      cancellationScheduledFor: organisation.cancellationScheduledFor ?? null,
    };
  }

  await ensureBillingCycleSchema();

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT
      o.billing_plan,
      o.billing_status,
      o.billing_cycle,
      o.trial_ends_at,
      o.billing_period_started_at,
      o.billing_period_ends_at,
      o.monthly_document_limit,
      o.included_users,
      o.stripe_customer_id,
      o.stripe_subscription_id,
      (
        SELECT COUNT(*)
        FROM receipts r
        WHERE r.organisation_id = o.id
          AND r.created_at >= COALESCE(o.billing_period_started_at, DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-01'))
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
  const status = normalizeBillingStatus(row.billing_status, billingPlan);
  return {
    planId: billingPlan,
    status,
    billingCycle: normalizeBillingCycle(row.billing_cycle),
    trialEndsAt: row.trial_ends_at ? new Date(row.trial_ends_at).toISOString() : (status === 'inactive' ? null : defaultTrialEndsAt(billingPlan)),
    billingPeriodStartedAt: row.billing_period_started_at ? new Date(row.billing_period_started_at).toISOString() : defaultUsagePeriodStart(),
    billingPeriodEndsAt: row.billing_period_ends_at ? new Date(row.billing_period_ends_at).toISOString() : null,
    monthlyDocumentLimit: normalizeNullableNumber(row.monthly_document_limit) ?? defaultMonthlyDocumentLimitForPlan(billingPlan),
    monthlyDocumentUsage: Number(row.monthly_document_usage ?? 0),
    includedUsers: normalizeNullableNumber(row.included_users) ?? defaultIncludedUsersForPlan(billingPlan),
    currentUserCount: Number(row.current_user_count ?? 0),
    stripeCustomerId: row.stripe_customer_id ? String(row.stripe_customer_id) : null,
    stripeSubscriptionId: row.stripe_subscription_id ? String(row.stripe_subscription_id) : null,
    cancellationScheduledFor: null,
  };
}

export async function updateOrganisationSettings(input: {
  organisationId: number;
  baseCurrency?: string;
  isVatRegistered: boolean;
  defaultTaxRate: string;
}) {
  const existingSettings = await getOrganisationSettings(input.organisationId);
  const baseCurrency = normalizeCurrencyCode(input.baseCurrency ?? existingSettings.baseCurrency);
  if (!pool) {
    const organisation = await getS3Organisation(input.organisationId);
    const next = {
      ...organisation,
      baseCurrency,
      isVatRegistered: input.isVatRegistered,
      defaultTaxRateCosts: sanitizeText(input.defaultTaxRate) || '20% Standard',
    };
    await putReceiptJsonObject(buildOrganisationKey(input.organisationId), next);
    return getOrganisationSettings(input.organisationId);
  }

  await pool.execute(
    `UPDATE organisations
     SET base_currency = ?, is_vat_registered = ?, default_tax_rate_costs = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [baseCurrency, input.isVatRegistered ? 1 : 0, sanitizeText(input.defaultTaxRate) || '20% Standard', input.organisationId],
  );

  return getOrganisationSettings(input.organisationId);
}

export async function updateOrganisationBillingProfile(input: {
  organisationId: number;
  billingPlan?: BillingPlanId;
  billingStatus?: BillingStatus;
  billingCycle?: BillingCycle;
  trialEndsAt?: string | null;
  billingPeriodStartedAt?: string | null;
  billingPeriodEndsAt?: string | null;
  monthlyDocumentLimit?: number | null;
  includedUsers?: number | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  cancellationScheduledFor?: string | null;
}) {
  if (!pool) {
    const organisation = await getS3Organisation(input.organisationId);
    const next: StoredOrganisation = {
      ...organisation,
      billingPlan: input.billingPlan ?? organisation.billingPlan ?? 'legacy',
      billingStatus: input.billingStatus ?? organisation.billingStatus ?? 'legacy',
      billingCycle: input.billingCycle ?? organisation.billingCycle ?? 'monthly',
      trialEndsAt: input.trialEndsAt === undefined ? organisation.trialEndsAt ?? null : input.trialEndsAt,
      billingPeriodStartedAt:
        input.billingPeriodStartedAt === undefined
          ? organisation.billingPeriodStartedAt ?? defaultUsagePeriodStart()
          : input.billingPeriodStartedAt,
      billingPeriodEndsAt:
        input.billingPeriodEndsAt === undefined ? organisation.billingPeriodEndsAt ?? null : input.billingPeriodEndsAt,
      monthlyDocumentLimit:
        input.monthlyDocumentLimit === undefined ? organisation.monthlyDocumentLimit ?? null : input.monthlyDocumentLimit,
      includedUsers: input.includedUsers === undefined ? organisation.includedUsers ?? null : input.includedUsers,
      stripeCustomerId:
        input.stripeCustomerId === undefined ? organisation.stripeCustomerId ?? null : input.stripeCustomerId,
      stripeSubscriptionId:
        input.stripeSubscriptionId === undefined
          ? organisation.stripeSubscriptionId ?? null
          : input.stripeSubscriptionId,
      cancellationScheduledFor:
        input.cancellationScheduledFor === undefined
          ? organisation.cancellationScheduledFor ?? null
          : input.cancellationScheduledFor,
    };
    await putReceiptJsonObject(buildOrganisationKey(input.organisationId), next);
    return getOrganisationBillingSummary(input.organisationId);
  }

  const hasBillingPlan = Object.prototype.hasOwnProperty.call(input, 'billingPlan');
  const hasBillingStatus = Object.prototype.hasOwnProperty.call(input, 'billingStatus');
  const hasBillingCycle = Object.prototype.hasOwnProperty.call(input, 'billingCycle');
  const hasTrialEndsAt = Object.prototype.hasOwnProperty.call(input, 'trialEndsAt');
  const hasBillingPeriodStartedAt = Object.prototype.hasOwnProperty.call(input, 'billingPeriodStartedAt');
  const hasBillingPeriodEndsAt = Object.prototype.hasOwnProperty.call(input, 'billingPeriodEndsAt');
  const hasMonthlyDocumentLimit = Object.prototype.hasOwnProperty.call(input, 'monthlyDocumentLimit');
  const hasIncludedUsers = Object.prototype.hasOwnProperty.call(input, 'includedUsers');
  const hasStripeCustomerId = Object.prototype.hasOwnProperty.call(input, 'stripeCustomerId');
  const hasStripeSubscriptionId = Object.prototype.hasOwnProperty.call(input, 'stripeSubscriptionId');

  await pool.execute(
    `UPDATE organisations
     SET billing_plan = CASE WHEN ? THEN ? ELSE billing_plan END,
         billing_status = CASE WHEN ? THEN ? ELSE billing_status END,
         billing_cycle = CASE WHEN ? THEN ? ELSE billing_cycle END,
         trial_ends_at = CASE WHEN ? THEN ? ELSE trial_ends_at END,
         billing_period_started_at = CASE WHEN ? THEN ? ELSE billing_period_started_at END,
         billing_period_ends_at = CASE WHEN ? THEN ? ELSE billing_period_ends_at END,
         monthly_document_limit = CASE WHEN ? THEN ? ELSE monthly_document_limit END,
         included_users = CASE WHEN ? THEN ? ELSE included_users END,
         stripe_customer_id = CASE WHEN ? THEN ? ELSE stripe_customer_id END,
         stripe_subscription_id = CASE WHEN ? THEN ? ELSE stripe_subscription_id END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      hasBillingPlan ? 1 : 0,
      input.billingPlan ?? null,
      hasBillingStatus ? 1 : 0,
      input.billingStatus ?? null,
      hasBillingCycle ? 1 : 0,
      input.billingCycle ?? null,
      hasTrialEndsAt ? 1 : 0,
      input.trialEndsAt ?? null,
      hasBillingPeriodStartedAt ? 1 : 0,
      input.billingPeriodStartedAt ?? null,
      hasBillingPeriodEndsAt ? 1 : 0,
      input.billingPeriodEndsAt ?? null,
      hasMonthlyDocumentLimit ? 1 : 0,
      input.monthlyDocumentLimit ?? null,
      hasIncludedUsers ? 1 : 0,
      input.includedUsers ?? null,
      hasStripeCustomerId ? 1 : 0,
      input.stripeCustomerId ?? null,
      hasStripeSubscriptionId ? 1 : 0,
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
    Pick<ReceiptRow, 'vendorName' | 'invoiceDate' | 'dueDate' | 'invoiceNumber' | 'category' | 'description' | 'customer' | 'paymentMethod' | 'currency' | 'netAmount' | 'vatAmount' | 'totalAmount' | 'taxRateApplied' | 'status' | 'baseCurrency' | 'exchangeRate' | 'exchangeRateDate' | 'exchangeRateProvider' | 'baseTotalAmount' | 'exchangeRateOverride' | 'exchangeRateNote' | 'foreignTaxAmount' | 'foreignTaxLabel' | 'ukVatTreatment'>
  >,
) {
  const existing = await getReceiptById(user, receiptId);
  const normalizedNeedsReview =
    updates.status === 'Ready' || updates.status === 'Published' || updates.status === 'Payment processing' || updates.status === 'Paid'
      ? false
      : updates.status === 'Review' || updates.status === 'Processing'
        ? true
        : undefined;

  if (!pool) {
    const taxProfile = await getOrganisationTaxProfile(user.organisationId);
    const next = {
      ...existing,
      ...updates,
      ...applyVatTrackingPreferenceToReceiptValues(
        {
          totalAmount: updates.totalAmount ?? existing.totalAmount,
          netAmount: updates.netAmount ?? existing.netAmount,
          vatAmount: updates.vatAmount ?? existing.vatAmount,
          taxRateApplied: updates.taxRateApplied ?? existing.taxRateApplied,
        },
        taxProfile,
      ),
      baseCurrency: updates.baseCurrency ?? existing.baseCurrency,
      exchangeRate: updates.exchangeRate ?? existing.exchangeRate,
      exchangeRateDate: updates.exchangeRateDate ?? existing.exchangeRateDate,
      exchangeRateProvider: updates.exchangeRateProvider ?? existing.exchangeRateProvider,
      baseTotalAmount: updates.baseTotalAmount ?? existing.baseTotalAmount,
      exchangeRateOverride: updates.exchangeRateOverride ?? existing.exchangeRateOverride,
      exchangeRateNote: updates.exchangeRateNote ?? existing.exchangeRateNote,
      needsReview: normalizedNeedsReview ?? existing.needsReview,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildReceiptMetadataKey(next), next);
    return next;
  }

  const taxProfile = await getOrganisationTaxProfile(user.organisationId);
  await ensureReceiptTaxTreatmentSchema();
  const normalizedVatValues = applyVatTrackingPreferenceToReceiptValues(
    {
      totalAmount: updates.totalAmount ?? null,
      netAmount: updates.netAmount ?? null,
      vatAmount: updates.vatAmount ?? null,
      taxRateApplied: updates.taxRateApplied ?? null,
    },
    taxProfile,
  );

  await pool.execute(
    `UPDATE receipts
     SET vendor_name = ?,
         invoice_date = ?,
         due_date = ?,
         invoice_number = ?,
         category = ?,
         description = ?,
         customer_name = ?,
         payment_method = ?,
         net_amount = ?,
         vat_amount = ?,
         total_amount = ?,
         tax_rate_applied = ?,
         currency = ?,
         base_currency = ?,
         exchange_rate = ?,
         exchange_rate_date = ?,
         exchange_rate_provider = ?,
         base_total_amount = ?,
         exchange_rate_override = ?,
         exchange_rate_note = ?,
         foreign_tax_amount = ?,
         foreign_tax_label = ?,
         uk_vat_treatment = ?,
         status = ?,
         needs_review = ?,
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
      updates.paymentMethod ?? existing.paymentMethod,
      normalizedVatValues.netAmount ?? null,
      normalizedVatValues.vatAmount ?? null,
      normalizedVatValues.totalAmount ?? null,
      normalizedVatValues.taxRateApplied ?? null,
      updates.currency ?? existing.currency,
      updates.baseCurrency ?? existing.baseCurrency,
      updates.exchangeRate ?? existing.exchangeRate,
      updates.exchangeRateDate ?? existing.exchangeRateDate,
      updates.exchangeRateProvider ?? existing.exchangeRateProvider,
      updates.baseTotalAmount ?? existing.baseTotalAmount,
      (updates.exchangeRateOverride ?? existing.exchangeRateOverride) ? 1 : 0,
      updates.exchangeRateNote ?? existing.exchangeRateNote,
      updates.foreignTaxAmount ?? existing.foreignTaxAmount,
      updates.foreignTaxLabel ?? existing.foreignTaxLabel,
      updates.ukVatTreatment ?? existing.ukVatTreatment,
      updates.status ?? 'Review',
      normalizedNeedsReview ?? true,
      receiptId,
      user.organisationId,
    ],
  );

  return getReceiptById(user, receiptId);
}

function normalizeCurrencyCode(value: string) {
  const currency = sanitizeText(value).toUpperCase();
  return /^[A-Z]{3}$/.test(currency) ? currency : 'GBP';
}

export async function saveReceiptExchangeRate(input: {
  user: AuthenticatedUser;
  receiptId: number;
  baseCurrency: string;
  exchangeRate: number;
  exchangeRateDate: string;
  exchangeRateProvider: string;
  baseTotalAmount: number | null;
}) {
  if (!pool) {
    const receipt = await getReceiptById(input.user, input.receiptId);
    const next = {
      ...receipt,
      baseCurrency: input.baseCurrency,
      exchangeRate: input.exchangeRate,
      exchangeRateDate: input.exchangeRateDate,
      exchangeRateProvider: input.exchangeRateProvider,
      baseTotalAmount: input.baseTotalAmount,
      exchangeRateOverride: false,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildReceiptMetadataKey(next), next);
    return next;
  }

  await pool.execute(
    `UPDATE receipts
     SET base_currency = ?, exchange_rate = ?, exchange_rate_date = ?, exchange_rate_provider = ?,
         base_total_amount = ?, exchange_rate_override = 0, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND organisation_id = ?`,
    [input.baseCurrency, input.exchangeRate, input.exchangeRateDate, input.exchangeRateProvider, input.baseTotalAmount, input.receiptId, input.user.organisationId],
  );
  return getReceiptById(input.user, input.receiptId);
}

export async function updateReimbursementPaymentStatus(
  user: AuthenticatedUser,
  fromStatus: 'Ready' | 'Payment processing',
  toStatus: 'Payment processing' | 'Paid',
  reimbursementBatch?: {
    id: string;
    createdAt: string;
  },
  receiptIds?: number[],
) {
  const selectedReceiptIds = receiptIds ? new Set(receiptIds) : null;
  const receipts = (await listReceipts(user, { workspaceContext: 'cost', limit: 50000 }))
    .filter((receipt) => receipt.paymentMethod === 'cash_personal')
    .filter((receipt) => receipt.status === fromStatus && !receipt.needsReview)
    .filter((receipt) => !selectedReceiptIds || selectedReceiptIds.has(receipt.id));

  if (!receipts.length) {
    return 0;
  }

  const updatedAt = new Date().toISOString();

  if (!pool) {
    await Promise.all(receipts.map((receipt) => putReceiptJsonObject(
      buildReceiptMetadataKey(receipt),
      {
        ...receipt,
        status: toStatus,
        needsReview: false,
        reimbursementBatchId: reimbursementBatch?.id ?? receipt.reimbursementBatchId ?? null,
        reimbursementBatchCreatedAt: reimbursementBatch?.createdAt ?? receipt.reimbursementBatchCreatedAt ?? null,
        updatedAt,
      },
    )));
    await reconcileReimbursementClaimStatuses(user);
    return receipts.length;
  }

  await ensureReceiptTaxTreatmentSchema();
  const placeholders = receipts.map(() => '?').join(', ');
  await pool.execute(
    `UPDATE receipts
     SET status = ?,
         needs_review = 0,
         reimbursement_batch_id = COALESCE(?, reimbursement_batch_id),
         reimbursement_batch_created_at = COALESCE(?, reimbursement_batch_created_at),
         updated_at = CURRENT_TIMESTAMP
     WHERE organisation_id = ?
       AND workspace_context = 'cost'
       AND payment_method = 'cash_personal'
       AND status = ?
       AND id IN (${placeholders})`,
    [
      toStatus,
      reimbursementBatch?.id ?? null,
      reimbursementBatch?.createdAt ?? null,
      user.organisationId,
      fromStatus,
      ...receipts.map((receipt) => receipt.id),
    ],
  );
  await reconcileReimbursementClaimStatuses(user);
  return receipts.length;
}

export async function deleteReceiptById(user: AuthenticatedUser, receiptId: number) {
  const existing = await getReceiptById(user, receiptId);
  if (existing.uploadedByUserId !== user.id) {
    throw forbiddenError('Only the account that uploaded this receipt can delete it.');
  }

  if (!pool) {
    await putReceiptJsonObject(`deleted/${existing.id}-${Date.now()}.json`, existing);
    await Promise.all([
      deleteReceiptObject(buildReceiptMetadataKey(existing)),
      deleteReceiptObject(existing.s3Key),
    ]);
    if (existing.claimId !== null) {
      await deleteEmptyClaimIfOrphaned(user.organisationId, existing.claimId);
    }
    return { success: true };
  }

  const claimId = existing.claimId;
  await pool.execute(
    `DELETE FROM receipts WHERE id = ? AND organisation_id = ? AND uploaded_by_user_id = ?`,
    [receiptId, user.organisationId, user.id],
  );
  if (claimId !== null) {
    await deleteEmptyClaimIfOrphaned(user.organisationId, claimId);
  }
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

export async function findUserById(organisationId: number, userId: number): Promise<UserRecord | null> {
  if (!pool) {
    const users = await listS3UsersForOrganisation(organisationId);
    const user = users.find((candidate) => candidate.id === userId);
    return user ? toUserRecord(user) : null;
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, email, password_hash, full_name, user_role AS role, status,
            invite_token, invited_by_user_id, created_at
     FROM users
     WHERE id = ? AND organisation_id = ?
     LIMIT 1`,
    [userId, organisationId],
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
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

export async function deleteOrganisationAccount(organisationId: number) {
  const userKeys = await listAllReceiptJsonKeys('users/');
  const users = await Promise.all(userKeys.map(async (key) => ({
    key,
    user: await getReceiptJsonObject<StoredUser>(key),
  })));
  const organisationUserKeys = users
    .filter(({ user }) => user.organisationId === organisationId)
    .map(({ key }) => key);

  const deletedRecordKeys = await listAllReceiptJsonKeys('deleted/');
  const deletedRecords = await Promise.all(deletedRecordKeys.map(async (key) => ({
    key,
    record: await getReceiptJsonObject<Partial<ReceiptRow>>(key),
  })));
  const organisationDeletedRecordKeys = deletedRecords
    .filter(({ record }) => record.organisationId === organisationId)
    .map(({ key }) => key);

  await Promise.all([
    deleteReceiptPrefix(`organisations/${organisationId}.json`),
    deleteReceiptPrefix(`receipt-records/org-${organisationId}/`),
    deleteReceiptPrefix(`receipts/org-${organisationId}/`),
    deleteReceiptPrefix(`expense-claims/org-${organisationId}/`),
    deleteReceiptPrefix(`supplier-rules/org-${organisationId}/`),
    ...organisationUserKeys.map((key) => deleteReceiptPrefix(key)),
    ...organisationDeletedRecordKeys.map((key) => deleteReceiptPrefix(key)),
  ]);

  if (pool) {
    await pool.execute(`DELETE FROM organisations WHERE id = ?`, [organisationId]);
  }

  return { success: true };
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
  workspaceContext: WorkspaceContext;
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

export async function applyCompanyCardClassification(input: {
  organisationId: number;
  uploadedByUserId: number;
  userRole: UserRole;
  workspaceContext: WorkspaceContext;
  document: NormalizedExpenseDocument;
  paymentMethod: PaymentMethod;
}) {
  if (input.workspaceContext !== 'cost') {
    return {
      paymentMethod: input.paymentMethod,
      paymentMethodMatchState: 'not_detected' as PaymentMethodMatchState,
      paymentMethodReviewRequired: false,
      matchedCompanyCardId: null,
    };
  }

  const lastFour = input.document.paymentCardLastFour;
  if (!lastFour) {
    return {
      paymentMethod: 'cash_personal' as const,
      paymentMethodMatchState: 'not_detected' as PaymentMethodMatchState,
      paymentMethodReviewRequired: false,
      matchedCompanyCardId: null,
    };
  }

  const cards = await listCompanyCards(input.organisationId);
  const normalizedNetwork = normalizeCardDescriptor(input.document.paymentCardNetwork);
  const normalizedIssuer = normalizeCardDescriptor(input.document.paymentCardIssuer);
  const matches = cards.filter((card) =>
    card.isActive &&
    card.lastFour === lastFour &&
    (!normalizedNetwork || !card.cardNetwork || normalizeCardDescriptor(card.cardNetwork) === normalizedNetwork) &&
    (!normalizedIssuer || !card.cardIssuer || normalizeCardDescriptor(card.cardIssuer) === normalizedIssuer),
  );

  // A shared last four digits cannot prove which company card was used. Keep
  // an employee's receipt out of reimbursement until an administrator resolves it.
  if (matches.length > 1 && input.userRole === 'Standard_Employee') {
    return {
      paymentMethod: 'cash_personal' as const,
      paymentMethodMatchState: 'employee_review' as PaymentMethodMatchState,
      paymentMethodReviewRequired: true,
      matchedCompanyCardId: null,
    };
  }

  if (matches.length !== 1) {
    return {
      paymentMethod: 'cash_personal' as const,
      paymentMethodMatchState: 'personal' as PaymentMethodMatchState,
      paymentMethodReviewRequired: false,
      matchedCompanyCardId: null,
    };
  }

  const matchedCard = matches[0];
  if (input.userRole !== 'Standard_Employee') {
    return {
      paymentMethod: 'business_card' as const,
      paymentMethodMatchState: 'company_card' as PaymentMethodMatchState,
      paymentMethodReviewRequired: false,
      matchedCompanyCardId: matchedCard.id,
    };
  }

  const exceptions = await listCompanyCardEmployeeExceptions(input.organisationId);
  const hasPersonalException = exceptions.some((exception) =>
    exception.isActive &&
    exception.companyCardId === matchedCard.id &&
    exception.employeeUserId === input.uploadedByUserId,
  );
  if (hasPersonalException) {
    return {
      paymentMethod: 'cash_personal' as const,
      paymentMethodMatchState: 'employee_exception' as PaymentMethodMatchState,
      paymentMethodReviewRequired: false,
      matchedCompanyCardId: matchedCard.id,
    };
  }

  return {
    paymentMethod: 'cash_personal' as const,
    paymentMethodMatchState: 'employee_review' as PaymentMethodMatchState,
    paymentMethodReviewRequired: true,
    matchedCompanyCardId: matchedCard.id,
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

export async function listCompanyCards(organisationId: number): Promise<CompanyCardRow[]> {
  if (!pool) {
    const keys = await listReceiptJsonKeys(`company-cards/org-${organisationId}/`, 500);
    const cards = await Promise.all(keys.map((key) => getReceiptJsonObject<CompanyCardRow>(key)));
    return cards.filter((card): card is CompanyCardRow => Boolean(card)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }
  await ensureCompanyCardSchema();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, label, card_network, card_issuer, last_four, is_active, created_at, updated_at
     FROM company_cards WHERE organisation_id = ? ORDER BY updated_at DESC`,
    [organisationId],
  );
  return rows.map(mapCompanyCardRow);
}

export async function upsertCompanyCard(input: Omit<CompanyCardRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }) {
  const lastFour = normalizeCardLastFour(input.lastFour);
  if (!lastFour) {
    throw validationError('Enter exactly four card digits.');
  }
  if (!sanitizeText(input.label)) {
    throw validationError('A company card label is required.');
  }
  if (!pool) {
    const cards = await listCompanyCards(input.organisationId);
    const existing = input.id ? cards.find((card) => card.id === input.id) : null;
    if (input.id && !existing) {
      throw notFoundError('Company card not found.');
    }
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const card: CompanyCardRow = {
      id: existing?.id ?? Date.now() + Math.floor(Math.random() * 1000),
      organisationId: input.organisationId,
      label: sanitizeText(input.label),
      cardNetwork: normalizeOptionalCardDescriptor(input.cardNetwork),
      cardIssuer: normalizeOptionalCardDescriptor(input.cardIssuer),
      lastFour,
      isActive: input.isActive,
      createdAt,
      updatedAt: new Date().toISOString(),
    };
    await putReceiptJsonObject(buildCompanyCardKey(card), card);
    return card;
  }
  await ensureCompanyCardSchema();
  if (input.id) {
    await pool.execute(
      `UPDATE company_cards SET label = ?, card_network = ?, card_issuer = ?, last_four = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organisation_id = ?`,
      [sanitizeText(input.label), normalizeOptionalCardDescriptor(input.cardNetwork), normalizeOptionalCardDescriptor(input.cardIssuer), lastFour, input.isActive ? 1 : 0, input.id, input.organisationId],
    );
  } else {
    await pool.execute(
      `INSERT INTO company_cards (organisation_id, label, card_network, card_issuer, last_four, is_active) VALUES (?, ?, ?, ?, ?, ?)`,
      [input.organisationId, sanitizeText(input.label), normalizeOptionalCardDescriptor(input.cardNetwork), normalizeOptionalCardDescriptor(input.cardIssuer), lastFour, input.isActive ? 1 : 0],
    );
  }
  const cards = await listCompanyCards(input.organisationId);
  const card = input.id ? cards.find((candidate) => candidate.id === input.id) : cards[0];
  if (!card) {
    throw new Error('Company card could not be saved.');
  }
  return card;
}

export async function deleteCompanyCard(organisationId: number, cardId: number) {
  if (!pool) {
    const card = (await listCompanyCards(organisationId)).find((candidate) => candidate.id === cardId);
    if (!card) {
      throw notFoundError('Company card not found.');
    }
    await deleteReceiptObject(buildCompanyCardKey(card));
    return { success: true };
  }
  await ensureCompanyCardSchema();
  await pool.execute('DELETE FROM company_card_employee_exceptions WHERE organisation_id = ? AND company_card_id = ?', [organisationId, cardId]);
  await pool.execute('DELETE FROM company_cards WHERE organisation_id = ? AND id = ?', [organisationId, cardId]);
  return { success: true };
}

export async function listCompanyCardEmployeeExceptions(organisationId: number): Promise<CompanyCardEmployeeExceptionRow[]> {
  if (!pool) {
    const keys = await listReceiptJsonKeys(`company-card-exceptions/org-${organisationId}/`, 500);
    const exceptions = await Promise.all(keys.map((key) => getReceiptJsonObject<CompanyCardEmployeeExceptionRow>(key)));
    return exceptions.filter((exception): exception is CompanyCardEmployeeExceptionRow => Boolean(exception));
  }
  await ensureCompanyCardSchema();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id, organisation_id, company_card_id, employee_user_id, is_active, created_at, updated_at
     FROM company_card_employee_exceptions WHERE organisation_id = ? ORDER BY updated_at DESC`,
    [organisationId],
  );
  return rows.map((row) => ({
    id: Number(row.id), organisationId: Number(row.organisation_id), companyCardId: Number(row.company_card_id), employeeUserId: Number(row.employee_user_id), isActive: Boolean(row.is_active), createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
  }));
}

export async function upsertCompanyCardEmployeeException(input: Omit<CompanyCardEmployeeExceptionRow, 'id' | 'createdAt' | 'updatedAt'> & { id?: number }) {
  const card = (await listCompanyCards(input.organisationId)).find((candidate) => candidate.id === input.companyCardId);
  if (!card) {
    throw validationError('Choose a company card from this organisation.');
  }
  if (!pool) {
    const existing = input.id ? (await listCompanyCardEmployeeExceptions(input.organisationId)).find((item) => item.id === input.id) : null;
    const createdAt = existing?.createdAt ?? new Date().toISOString();
    const exception: CompanyCardEmployeeExceptionRow = { id: existing?.id ?? Date.now() + Math.floor(Math.random() * 1000), organisationId: input.organisationId, companyCardId: input.companyCardId, employeeUserId: input.employeeUserId, isActive: input.isActive, createdAt, updatedAt: new Date().toISOString() };
    await putReceiptJsonObject(buildCompanyCardExceptionKey(exception), exception);
    return exception;
  }
  await ensureCompanyCardSchema();
  if (input.id) {
    await pool.execute('UPDATE company_card_employee_exceptions SET company_card_id = ?, employee_user_id = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organisation_id = ?', [input.companyCardId, input.employeeUserId, input.isActive ? 1 : 0, input.id, input.organisationId]);
  } else {
    await pool.execute('INSERT INTO company_card_employee_exceptions (organisation_id, company_card_id, employee_user_id, is_active) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE is_active = VALUES(is_active), updated_at = CURRENT_TIMESTAMP', [input.organisationId, input.companyCardId, input.employeeUserId, input.isActive ? 1 : 0]);
  }
  const exceptions = await listCompanyCardEmployeeExceptions(input.organisationId);
  const exception = input.id ? exceptions.find((item) => item.id === input.id) : exceptions.find((item) => item.companyCardId === input.companyCardId && item.employeeUserId === input.employeeUserId);
  if (!exception) {
    throw new Error('Employee exception could not be saved.');
  }
  return exception;
}

export async function deleteCompanyCardEmployeeException(organisationId: number, exceptionId: number) {
  if (!pool) {
    const exception = (await listCompanyCardEmployeeExceptions(organisationId)).find((item) => item.id === exceptionId);
    if (!exception) {
      throw notFoundError('Employee exception not found.');
    }
    await deleteReceiptObject(buildCompanyCardExceptionKey(exception));
    return { success: true };
  }
  await ensureCompanyCardSchema();
  await pool.execute('DELETE FROM company_card_employee_exceptions WHERE id = ? AND organisation_id = ?', [exceptionId, organisationId]);
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
      content_sha256,
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
  if (claim.claimType === 'mileage') {
    return {
      ...claim,
      totalAmount: Number(claim.mileageTotalAmount ?? claim.totalAmount ?? 0),
      documentCount: 0,
    };
  }
  const attached = receipts.filter((receipt) => receipt.claimId === claim.id);
  return {
    ...claim,
    totalAmount: attached.reduce((sum, receipt) => sum + (receipt.baseTotalAmount ?? receipt.totalAmount ?? 0), 0),
    documentCount: attached.length,
  };
}

/**
 * Keep parent claims in step with reimbursement batches. Exporting a batch
 * clears it from the pending review queue; final payment settles the claim.
 */
async function reconcileReimbursementClaimStatuses(
  user: AuthenticatedUser,
  knownReceipts?: ReceiptRow[],
): Promise<Map<number, 'approved' | 'paid'>> {
  if (!pool) {
    const keys = await listReceiptJsonKeys(`expense-claims/org-${user.organisationId}/`, 1000);
    const claims = await Promise.all(keys.map((key) => getReceiptJsonObject<StoredClaim>(key)));
    const visibleClaims = claims.filter((claim) =>
      claim.organisationId === user.organisationId &&
      (user.role === 'Business_Admin' || claim.createdByUserId === user.id),
    );
    const receipts = knownReceipts ?? await listReceipts(user, { workspaceContext: 'cost', limit: 50000 });
    const reconciledClaims: Array<{ claim: StoredClaim; status: 'approved' | 'paid' }> = [];
    visibleClaims.forEach((claim) => {
      if (claim.status === 'paid' || claim.status === 'rejected') {
        return;
      }
      const attached = receipts.filter((receipt) => receipt.claimId === claim.id);
      if (!attached.length) {
        return;
      }
      if (attached.every((receipt) => receipt.status === 'Paid')) {
        reconciledClaims.push({ claim, status: 'paid' });
        return;
      }
      if (claim.status === 'pending' && attached.every((receipt) => receipt.status === 'Payment processing' || receipt.status === 'Paid')) {
        reconciledClaims.push({ claim, status: 'approved' });
      }
    });

    await Promise.all(reconciledClaims.map(({ claim, status }) => putReceiptJsonObject(buildClaimKey(claim), {
      ...claim,
      status,
      updatedAt: new Date().toISOString(),
    })));
    return new Map(reconciledClaims.map(({ claim, status }) => [claim.id, status]));
  }

  const userScope = user.role === 'Business_Admin' ? '' : 'AND c.created_by_user_id = ?';
  const params: Array<number> = [user.organisationId];
  if (user.role !== 'Business_Admin') {
    params.push(user.id);
  }

  await pool.execute(
    `UPDATE expense_claims c
     SET c.status = 'approved', c.updated_at = CURRENT_TIMESTAMP
     WHERE c.organisation_id = ?
       AND c.status = 'pending'
       ${userScope}
       AND EXISTS (
         SELECT 1
         FROM receipts r
         WHERE r.organisation_id = c.organisation_id
           AND r.claim_id = c.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM receipts r
         WHERE r.organisation_id = c.organisation_id
           AND r.claim_id = c.id
           AND r.status NOT IN ('Payment processing', 'Paid')
       )`,
    params,
  );

  await pool.execute(
    `UPDATE expense_claims c
     SET c.status = 'paid', c.updated_at = CURRENT_TIMESTAMP
     WHERE c.organisation_id = ?
       AND c.status IN ('pending', 'approved')
       ${userScope}
       AND EXISTS (
         SELECT 1
         FROM receipts r
         WHERE r.organisation_id = c.organisation_id
           AND r.claim_id = c.id
       )
       AND NOT EXISTS (
         SELECT 1
         FROM receipts r
         WHERE r.organisation_id = c.organisation_id
           AND r.claim_id = c.id
           AND r.status <> 'Paid'
       )`,
    params,
  );
  return new Map();
}

async function deleteEmptyClaimIfOrphaned(organisationId: number, claimId: number) {
  if (!pool) {
    const claim = await getS3Claim(organisationId, claimId);
    if (!claim) {
      return;
    }
    if (claim.claimType === 'mileage') {
      return;
    }
    const receipts = await listOrganisationWorkspaceReceiptsFromS3(organisationId, 'cost', 1000);
    const stillAttached = receipts.some((receipt) => receipt.claimId === claimId);
    if (!stillAttached) {
      await deleteReceiptObject(buildClaimKey(claim));
    }
    return;
  }

  await ensureExpenseClaimMileageSchema();
  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT c.claim_type, COUNT(r.id) AS receipt_count
     FROM expense_claims c
     LEFT JOIN receipts r ON r.organisation_id = c.organisation_id AND r.claim_id = c.id
     WHERE c.organisation_id = ? AND c.id = ?
     GROUP BY c.id, c.claim_type`,
    [organisationId, claimId],
  );
  if (String(rows[0]?.claim_type) === 'mileage') {
    return;
  }
  const receiptCount = Number(rows[0]?.receipt_count ?? 0);
  if (receiptCount === 0) {
    await pool.execute(`DELETE FROM expense_claims WHERE id = ? AND organisation_id = ?`, [claimId, organisationId]);
  }
}

function applyVatTrackingPreferenceToReceiptValues(
  values: Pick<ReceiptRow, 'totalAmount' | 'netAmount' | 'vatAmount' | 'taxRateApplied'>,
  taxProfile: { isVatRegistered: boolean },
) {
  if (taxProfile.isVatRegistered) {
    return values;
  }

  const grossAmount =
    values.totalAmount ??
    (values.netAmount !== null && values.netAmount !== undefined
      ? values.netAmount + (values.vatAmount ?? 0)
      : null);

  return {
    totalAmount: grossAmount,
    netAmount: grossAmount,
    vatAmount: grossAmount === null ? 0 : 0,
    taxRateApplied: 'No VAT' as ReceiptRow['taxRateApplied'],
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
  if (receipt.paymentMethodReviewRequired) {
    throw validationError('Resolve the possible company-card match before adding this purchase to an expense claim.');
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
  const createdAt = new Date(row.created_at).toISOString();
  return {
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    uploadedByUserId: Number(row.uploaded_by_user_id),
    uploadedByName: row.uploaded_by_name ? String(row.uploaded_by_name) : null,
    uploadedByEmail: row.uploaded_by_email ? String(row.uploaded_by_email) : null,
    uploadedByDepartmentId: row.uploaded_by_department_id === null || row.uploaded_by_department_id === undefined
      ? null
      : Number(row.uploaded_by_department_id),
    uploadedByDepartmentName: row.uploaded_by_department_name ? String(row.uploaded_by_department_name) : null,
    workspaceContext: String(row.workspace_context) as WorkspaceContext,
    paymentMethod: String(row.payment_method) as PaymentMethod,
    paymentMethodMatchState: normalizePaymentMethodMatchState(row.payment_method_match_state),
    paymentMethodReviewRequired: Boolean(row.payment_method_review_required),
    matchedCompanyCardId: row.matched_company_card_id === null || row.matched_company_card_id === undefined ? null : Number(row.matched_company_card_id),
    claimId: row.claim_id === null ? null : Number(row.claim_id),
    status: normalizeReceiptStatus(row.status),
    category: row.category ? String(row.category) : null,
    description: row.description ? String(row.description) : null,
    customer: row.customer_name ? String(row.customer_name) : null,
    receiptSource: (row.receipt_source ? String(row.receipt_source) : 'web_upload') as ReceiptRow['receiptSource'],
    sourceFilename: String(row.source_filename),
    sourceMimeType: String(row.source_mime_type),
    contentSha256: row.content_sha256 ? String(row.content_sha256) : null,
    s3Bucket: String(row.s3_bucket),
    s3Key: String(row.s3_key),
    locale: String(row.locale),
    documentType: row.document_type,
    vendorName: row.vendor_name,
    invoiceDate: normalizeReceiptDate(row.invoice_date ? new Date(row.invoice_date).toISOString().slice(0, 10) : null, createdAt),
    dueDate: row.due_date ? new Date(row.due_date).toISOString().slice(0, 10) : null,
    invoiceNumber: row.invoice_number,
    paymentCardLastFour: normalizeCardLastFour(row.detected_card_last_four),
    paymentCardNetwork: normalizeOptionalCardDescriptor(row.detected_card_network),
    paymentCardIssuer: normalizeOptionalCardDescriptor(row.detected_card_issuer),
    currency: row.currency,
    baseCurrency: row.base_currency ? String(row.base_currency) : 'GBP',
    exchangeRate: toDbNumber(row.exchange_rate),
    exchangeRateDate: row.exchange_rate_date ? new Date(row.exchange_rate_date).toISOString().slice(0, 10) : null,
    exchangeRateProvider: row.exchange_rate_provider ? String(row.exchange_rate_provider) : null,
    baseTotalAmount: toDbNumber(row.base_total_amount),
    exchangeRateOverride: Boolean(row.exchange_rate_override),
    exchangeRateNote: row.exchange_rate_note ? String(row.exchange_rate_note) : null,
    totalAmount: toDbNumber(row.total_amount),
    netAmount: toDbNumber(row.net_amount) ?? toDbNumber(row.subtotal_amount),
    vatAmount: toDbNumber(row.vat_amount) ?? toDbNumber(row.total_tax_amount),
    taxRateApplied: row.tax_rate_applied ? String(row.tax_rate_applied) : null,
    subtotalAmount: toDbNumber(row.subtotal_amount),
    totalTaxAmount: toDbNumber(row.total_tax_amount),
    foreignTaxAmount: toDbNumber(row.foreign_tax_amount),
    foreignTaxLabel: row.foreign_tax_label ? String(row.foreign_tax_label) : null,
    ukVatTreatment: normalizeUkVatTreatment(row.uk_vat_treatment, row.currency),
    reimbursementBatchId: row.reimbursement_batch_id ? String(row.reimbursement_batch_id) : null,
    reimbursementBatchCreatedAt: row.reimbursement_batch_created_at
      ? new Date(row.reimbursement_batch_created_at).toISOString()
      : null,
    confidenceScore: toDbNumber(row.confidence_score),
    confidenceSource: row.confidence_source,
    needsReview: Boolean(row.needs_review),
    extractionProvider: String(row.extraction_provider),
    extractionModel: String(row.extraction_model),
    lineItems: safeJsonArrayParse(row.line_items),
    taxBreakdown: safeJsonArrayParse(row.tax_breakdown),
    notes: safeJsonArrayParse(row.notes),
    rawTextSummary: row.raw_text_summary,
    createdAt,
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapCompanyCardRow(row: mysql.RowDataPacket): CompanyCardRow {
  return {
    id: Number(row.id),
    organisationId: Number(row.organisation_id),
    label: String(row.label),
    cardNetwork: normalizeOptionalCardDescriptor(row.card_network),
    cardIssuer: normalizeOptionalCardDescriptor(row.card_issuer),
    lastFour: String(row.last_four),
    isActive: Boolean(row.is_active),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function normalizeCardLastFour(value: unknown) {
  const digits = sanitizeText(value).replace(/\D/g, '');
  return /^\d{4}$/.test(digits) ? digits : null;
}

function normalizeOptionalCardDescriptor(value: unknown) {
  const text = sanitizeText(value);
  return text && text.length <= 120 ? text : null;
}

function normalizeCardDescriptor(value: unknown) {
  return normalizeOptionalCardDescriptor(value)?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
}

function normalizePaymentMethodMatchState(value: unknown): PaymentMethodMatchState {
  return value === 'personal' || value === 'company_card' || value === 'employee_review' || value === 'employee_exception'
    ? value
    : 'not_detected';
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

function normalizeExactDuplicateFileName(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase() ?? '';
  const fileNameOnly = trimmed.split(/[\\/]/).pop() ?? trimmed;
  const stem = fileNameOnly.replace(/\.[a-z0-9]+$/i, '');
  return stem.replace(/[^a-z0-9]+/g, '');
}

function buildS3BackedReceiptRow(input: {
  organisationId: number;
  uploadedByUserId: number;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  paymentMethodMatchState?: PaymentMethodMatchState;
  paymentMethodReviewRequired?: boolean;
  matchedCompanyCardId?: number | null;
  claimId?: number | null;
  status?: ReceiptRow['status'];
  category?: string | null;
  description?: string | null;
  customer?: string | null;
  receiptSource?: ReceiptSource;
  sourceFileName: string;
  sourceMimeType: string;
  contentSha256?: string | null;
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
  const invoiceDate = normalizeReceiptDate(input.document.invoiceDate, createdAt);
  return {
    id,
    organisationId: input.organisationId,
    uploadedByUserId: input.uploadedByUserId,
    workspaceContext: input.workspaceContext,
    paymentMethod: input.paymentMethod,
    paymentMethodMatchState: input.paymentMethodMatchState ?? 'not_detected',
    paymentMethodReviewRequired: input.paymentMethodReviewRequired ?? false,
    matchedCompanyCardId: input.matchedCompanyCardId ?? null,
    claimId: input.claimId ?? null,
    status: input.status ?? (input.document.needsReview ? 'Review' : 'Ready'),
    category: input.category ?? 'Uncategorised',
    description: input.description ?? null,
    customer: input.customer ?? null,
    receiptSource: input.receiptSource ?? 'web_upload',
    sourceFilename: input.sourceFileName,
    sourceMimeType: input.sourceMimeType,
    contentSha256: input.contentSha256 ?? null,
    s3Bucket: input.s3Bucket,
    s3Key: input.s3Key,
    locale: input.locale,
    documentType: input.document.documentType,
    vendorName: input.document.vendorName,
    invoiceDate,
    dueDate: input.document.dueDate,
    invoiceNumber: input.document.invoiceNumber,
    paymentCardLastFour: input.document.paymentCardLastFour,
    paymentCardNetwork: input.document.paymentCardNetwork,
    paymentCardIssuer: input.document.paymentCardIssuer,
    currency: input.document.currency,
    baseCurrency: 'GBP',
    exchangeRate: null,
    exchangeRateDate: null,
    exchangeRateProvider: null,
    baseTotalAmount: null,
    exchangeRateOverride: false,
    exchangeRateNote: null,
    totalAmount: input.document.totalAmount,
    netAmount: input.document.netAmount,
    vatAmount: input.document.vatAmount,
    taxRateApplied: input.document.taxRateApplied,
    subtotalAmount: input.document.subtotalAmount,
    totalTaxAmount: input.document.totalTaxAmount,
    foreignTaxAmount: input.document.foreignTaxAmount ?? null,
    foreignTaxLabel: input.document.foreignTaxLabel ?? null,
    ukVatTreatment: input.document.ukVatTreatment ?? 'not_applicable',
    reimbursementBatchId: null,
    reimbursementBatchCreatedAt: null,
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

function normalizeReceiptDate(invoiceDate: string | null | undefined, createdAt: string) {
  return invoiceDate ?? createdAt.slice(0, 10);
}

function normalizeReceiptStatus(status: unknown): ReceiptRow['status'] {
  const trimmed = typeof status === 'string' ? status.trim() : '';
  if (trimmed === 'Processing' || trimmed === 'Ready' || trimmed === 'Review' || trimmed === 'Published' || trimmed === 'Payment processing' || trimmed === 'Paid') {
    return trimmed;
  }
  return 'Review';
}

function normalizeUkVatTreatment(value: unknown, sourceCurrency: unknown): ReceiptRow['ukVatTreatment'] {
  const treatment = typeof value === 'string' ? value.trim() : '';
  if (
    treatment === 'not_applicable' ||
    treatment === 'no_uk_vat_to_reclaim' ||
    treatment === 'uk_vat_included' ||
    treatment === 'reverse_charge_required' ||
    treatment === 'import_vat' ||
    treatment === 'accountant_review'
  ) {
    return treatment;
  }
  return String(sourceCurrency ?? 'GBP').toUpperCase() === 'GBP' ? 'not_applicable' : 'no_uk_vat_to_reclaim';
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

function buildCompanyCardKey(card: CompanyCardRow) {
  return `company-cards/org-${card.organisationId}/${card.createdAt.slice(0, 10)}/${card.id}.json`;
}

function buildCompanyCardExceptionKey(exception: CompanyCardEmployeeExceptionRow) {
  return `company-card-exceptions/org-${exception.organisationId}/${exception.createdAt.slice(0, 10)}/${exception.id}.json`;
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
  const initialBillingStatus = (billingPlan === 'legacy' ? 'legacy' : 'inactive') as BillingStatus;
  const organisation = {
    id: Date.now(),
    name,
    isVatRegistered: true,
    defaultTaxRateCosts: '20% Standard',
    billingPlan,
    billingStatus: initialBillingStatus,
    billingCycle,
    trialEndsAt: initialBillingStatus === 'inactive' ? null : defaultTrialEndsAt(billingPlan),
    billingPeriodStartedAt: defaultUsagePeriodStart(),
    billingPeriodEndsAt: null,
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

async function getS3Claim(organisationId: number, claimId: number): Promise<StoredClaim | null> {
  const keys = await listReceiptJsonKeys(`expense-claims/org-${organisationId}/`, 1000);
  const matchingKey = keys.find((key) => key.endsWith(`/${claimId}.json`));
  if (!matchingKey) {
    return null;
  }
  return getReceiptJsonObject<StoredClaim>(matchingKey);
}

async function listS3Organisations() {
  const keys = await listReceiptJsonKeys('organisations/', 500);
  return Promise.all(keys.map((key) => getReceiptJsonObject<StoredOrganisation>(key)));
}

async function listS3UsersForOrganisation(organisationId: number) {
  const keys = await listReceiptJsonKeys('users/', 500);
  const users = await Promise.all(keys.map((key) => getReceiptJsonObject<StoredUser>(key)));
  return users.filter((user) => user.organisationId === organisationId);
}

async function countS3DocumentsForBillingPeriod(organisationId: number, billingPeriodStartedAt: string) {
  const prefix = `receipt-records/org-${organisationId}/`;
  const keys = await listReceiptJsonKeys(prefix, 2000);
  return keys.filter((key) => {
    const match = key.match(/\/user-\d+\/(\d{4}-\d{2}-\d{2})\//);
    return match ? Date.parse(`${match[1]}T00:00:00.000Z`) >= Date.parse(billingPeriodStartedAt) : false;
  }).length;
}

function defaultUsagePeriodStart() {
  return `${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`;
}

function defaultMonthlyDocumentLimitForPlan(planId: BillingPlanId) {
  switch (planId) {
    case 'capture':
      return 250;
    case 'control':
      return 1500;
    case 'operations':
      return 3000;
    default:
      return null;
  }
}

function defaultIncludedUsersForPlan(planId: BillingPlanId) {
  switch (planId) {
    case 'capture':
      return 5;
    case 'control':
      return 30;
    case 'operations':
      return 60;
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
    departmentId: user.departmentId ?? null,
    createdAt: user.createdAt,
    emailConfirmationGraceStartedAt: user.emailConfirmationGraceStartedAt ?? null,
  };
}

function buildInviteLink(inviteToken: string, email: string) {
  const base = awsEnv.inviteBaseUrl.replace(/\/$/, '');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}inviteToken=${encodeURIComponent(inviteToken)}&email=${encodeURIComponent(email)}`;
}

export function buildConfirmationEmailLink(confirmationToken: string, email: string) {
  // Send people to the Exdox website, not directly to the API. This keeps the
  // confirmation flow usable from any device and avoids exposing raw API output.
  const base = awsEnv.confirmEmailBaseUrl.replace(/\/$/, '');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}token=${encodeURIComponent(confirmationToken)}&email=${encodeURIComponent(email)}`;
}

export function buildPasswordResetLink(resetToken: string, email: string) {
  const base = awsEnv.resetPasswordBaseUrl.replace(/\/$/, '');
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}token=${encodeURIComponent(resetToken)}&email=${encodeURIComponent(email)}`;
}

export async function findOrganisationIdByStripeCustomerId(stripeCustomerId: string): Promise<number | null> {
  if (!stripeCustomerId) {
    return null;
  }

  if (!pool) {
    const keys = await listReceiptJsonKeys('organisations/', 1000);
    for (const key of keys) {
      const organisation = await getReceiptJsonObject<StoredOrganisation>(key);
      if (organisation.stripeCustomerId === stripeCustomerId) {
        return organisation.id;
      }
    }
    return null;
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id
     FROM organisations
     WHERE stripe_customer_id = ?
     LIMIT 1`,
    [stripeCustomerId],
  );
  const row = rows[0];
  return row ? Number(row.id) : null;
}

export async function findOrganisationIdByStripeSubscriptionId(stripeSubscriptionId: string): Promise<number | null> {
  if (!stripeSubscriptionId) {
    return null;
  }

  if (!pool) {
    const keys = await listReceiptJsonKeys('organisations/', 1000);
    for (const key of keys) {
      const organisation = await getReceiptJsonObject<StoredOrganisation>(key);
      if (organisation.stripeSubscriptionId === stripeSubscriptionId) {
        return organisation.id;
      }
    }
    return null;
  }

  const [rows] = await pool.query<mysql.RowDataPacket[]>(
    `SELECT id
     FROM organisations
     WHERE stripe_subscription_id = ?
     LIMIT 1`,
    [stripeSubscriptionId],
  );
  const row = rows[0];
  return row ? Number(row.id) : null;
}

function normalizeEmail(value: string) {
  return sanitizeText(value).toLowerCase();
}

function emailDomain(value: string) {
  const parts = normalizeEmail(value).split('@');
  return parts.length === 2 ? parts[1] : '';
}

function normalizeName(value: string | null | undefined) {
  const text = sanitizeText(value);
  return text || null;
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

function domainConflictError() {
  const error = new Error(
    'This company email domain is linked to more than one workspace. Contact contact@exdox.co.uk so we can verify the correct company.',
  ) as Error & { statusCode?: number; code?: string };
  error.statusCode = 409;
  error.code = 'company_domain_conflict';
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
