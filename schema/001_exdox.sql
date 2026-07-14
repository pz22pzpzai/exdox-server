CREATE DATABASE IF NOT EXISTS receiptflow CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE receiptflow;

CREATE TABLE IF NOT EXISTS organisations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(255) NOT NULL,
  is_vat_registered TINYINT(1) NOT NULL DEFAULT 0,
  default_tax_rate_costs VARCHAR(64) NOT NULL DEFAULT 'No VAT',
  billing_plan VARCHAR(32) NOT NULL DEFAULT 'legacy',
  billing_status VARCHAR(32) NOT NULL DEFAULT 'legacy',
  billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly',
  trial_ends_at TIMESTAMP NULL DEFAULT NULL,
  monthly_document_limit INT NULL DEFAULT NULL,
  included_users INT NULL DEFAULT NULL,
  stripe_customer_id VARCHAR(255) NULL,
  stripe_subscription_id VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
);

ALTER TABLE organisations
  ADD COLUMN IF NOT EXISTS is_vat_registered TINYINT(1) NOT NULL DEFAULT 0 AFTER name,
  ADD COLUMN IF NOT EXISTS default_tax_rate_costs VARCHAR(64) NOT NULL DEFAULT 'No VAT' AFTER is_vat_registered,
  ADD COLUMN IF NOT EXISTS billing_plan VARCHAR(32) NOT NULL DEFAULT 'legacy' AFTER default_tax_rate_costs,
  ADD COLUMN IF NOT EXISTS billing_status VARCHAR(32) NOT NULL DEFAULT 'legacy' AFTER billing_plan,
  ADD COLUMN IF NOT EXISTS billing_cycle VARCHAR(32) NOT NULL DEFAULT 'monthly' AFTER billing_status,
  ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP NULL DEFAULT NULL AFTER billing_cycle,
  ADD COLUMN IF NOT EXISTS monthly_document_limit INT NULL DEFAULT NULL AFTER trial_ends_at,
  ADD COLUMN IF NOT EXISTS included_users INT NULL DEFAULT NULL AFTER monthly_document_limit,
  ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255) NULL AFTER included_users,
  ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255) NULL AFTER stripe_customer_id;

CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id BIGINT UNSIGNED NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NULL,
  full_name VARCHAR(255) NULL,
  user_role ENUM('Business_Admin', 'Standard_Employee') NOT NULL DEFAULT 'Standard_Employee',
  status ENUM('pending_invite', 'active') NOT NULL DEFAULT 'active',
  invite_token VARCHAR(255) NULL,
  invited_by_user_id BIGINT UNSIGNED NULL,
  invite_sent_at TIMESTAMP NULL DEFAULT NULL,
  invitation_accepted_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_invite_token (invite_token),
  KEY idx_users_org_role (organisation_id, user_role),
  CONSTRAINT fk_users_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_users_invited_by
    FOREIGN KEY (invited_by_user_id) REFERENCES users(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS expense_claims (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id BIGINT UNSIGNED NOT NULL,
  created_by_user_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  currency CHAR(3) NOT NULL DEFAULT 'GBP',
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_expense_claims_org_created (organisation_id, created_at),
  KEY idx_expense_claims_created_by (created_by_user_id),
  CONSTRAINT fk_expense_claims_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_expense_claims_created_by
    FOREIGN KEY (created_by_user_id) REFERENCES users(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id BIGINT UNSIGNED NOT NULL,
  uploaded_by_user_id BIGINT UNSIGNED NOT NULL,
  workspace_context ENUM('cost', 'sales', 'vault') NOT NULL DEFAULT 'cost',
  payment_method ENUM('business_card', 'cash_personal', 'bank_transfer', 'not_applicable') NOT NULL DEFAULT 'business_card',
  claim_id BIGINT UNSIGNED NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Processing',
  category VARCHAR(255) NULL,
  description TEXT NULL,
  customer_name VARCHAR(255) NULL,
  receipt_source VARCHAR(32) NOT NULL DEFAULT 'web_upload',
  source_filename VARCHAR(255) NOT NULL,
  source_mime_type VARCHAR(120) NOT NULL,
  s3_bucket VARCHAR(255) NOT NULL,
  s3_key VARCHAR(1024) NOT NULL,
  locale VARCHAR(32) NOT NULL DEFAULT 'en-GB',
  document_type ENUM('receipt', 'invoice', 'unknown') NOT NULL DEFAULT 'unknown',
  vendor_name VARCHAR(255) NULL,
  invoice_date DATE NULL,
  due_date DATE NULL,
  invoice_number VARCHAR(120) NULL,
  currency CHAR(3) NULL,
  total_amount DECIMAL(12, 2) NULL,
  net_amount DECIMAL(12, 2) NULL,
  vat_amount DECIMAL(12, 2) NULL,
  tax_rate_applied VARCHAR(64) NULL,
  subtotal_amount DECIMAL(12, 2) NULL,
  total_tax_amount DECIMAL(12, 2) NULL,
  confidence_score DECIMAL(6, 4) NULL,
  confidence_source ENUM('model_self_assessment', 'unavailable') NOT NULL DEFAULT 'unavailable',
  needs_review TINYINT(1) NOT NULL DEFAULT 1,
  extraction_provider VARCHAR(64) NOT NULL DEFAULT 'openai',
  extraction_model VARCHAR(64) NOT NULL,
  line_items JSON NOT NULL,
  tax_breakdown JSON NOT NULL,
  notes JSON NOT NULL,
  raw_text_summary TEXT NULL,
  raw_extraction_json JSON NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_receipts_org_created (organisation_id, created_at),
  KEY idx_receipts_uploaded_by (uploaded_by_user_id),
  KEY idx_receipts_org_context_created (organisation_id, workspace_context, created_at),
  KEY idx_receipts_claim_id (claim_id),
  UNIQUE KEY uq_receipts_s3_key (s3_key(255)),
  KEY idx_receipts_vendor_name (vendor_name),
  KEY idx_receipts_document_type (document_type),
  CONSTRAINT fk_receipts_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_receipts_uploaded_by
    FOREIGN KEY (uploaded_by_user_id) REFERENCES users(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_receipts_claim
    FOREIGN KEY (claim_id) REFERENCES expense_claims(id)
    ON DELETE SET NULL
);

ALTER TABLE receipts
  ADD COLUMN IF NOT EXISTS status VARCHAR(32) NOT NULL DEFAULT 'Processing' AFTER claim_id,
  ADD COLUMN IF NOT EXISTS category VARCHAR(255) NULL AFTER status,
  ADD COLUMN IF NOT EXISTS description TEXT NULL AFTER category,
  ADD COLUMN IF NOT EXISTS customer_name VARCHAR(255) NULL AFTER description,
  ADD COLUMN IF NOT EXISTS receipt_source VARCHAR(32) NOT NULL DEFAULT 'web_upload' AFTER customer_name,
  ADD COLUMN IF NOT EXISTS net_amount DECIMAL(12, 2) NULL AFTER total_amount,
  ADD COLUMN IF NOT EXISTS vat_amount DECIMAL(12, 2) NULL AFTER net_amount,
  ADD COLUMN IF NOT EXISTS tax_rate_applied VARCHAR(64) NULL AFTER vat_amount;

CREATE TABLE IF NOT EXISTS supplier_rules (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id BIGINT UNSIGNED NOT NULL,
  supplier_match_text VARCHAR(255) NOT NULL,
  category VARCHAR(255) NOT NULL,
  tax_rate VARCHAR(64) NOT NULL,
  payment_method ENUM('business_card', 'cash_personal', 'bank_transfer', 'not_applicable') NOT NULL DEFAULT 'business_card',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_supplier_rules_org_active (organisation_id, is_active),
  CONSTRAINT fk_supplier_rules_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bank_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id BIGINT UNSIGNED NOT NULL,
  transaction_id VARCHAR(191) NOT NULL,
  booking_date DATE NOT NULL,
  remittance_information VARCHAR(255) NOT NULL,
  transaction_amount DECIMAL(12, 2) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'Open',
  matched_receipt_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bank_transactions_transaction_id (transaction_id),
  KEY idx_bank_transactions_org_status (organisation_id, status),
  KEY idx_bank_transactions_match (matched_receipt_id),
  CONSTRAINT fk_bank_transactions_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_bank_transactions_receipt
    FOREIGN KEY (matched_receipt_id) REFERENCES receipts(id)
    ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS bank_requisitions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organisation_id BIGINT UNSIGNED NOT NULL,
  provider VARCHAR(64) NOT NULL,
  external_requisition_id VARCHAR(191) NOT NULL,
  institution_id VARCHAR(191) NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'pending',
  redirect_url TEXT NOT NULL,
  callback_state VARCHAR(191) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bank_requisitions_external (external_requisition_id),
  UNIQUE KEY uq_bank_requisitions_state (callback_state),
  KEY idx_bank_requisitions_org_status (organisation_id, status),
  CONSTRAINT fk_bank_requisitions_organisation
    FOREIGN KEY (organisation_id) REFERENCES organisations(id)
    ON DELETE CASCADE
);
