export type DocumentType = 'receipt' | 'invoice' | 'unknown';
export type WorkspaceContext = 'cost' | 'sales' | 'vault';
export type PaymentMethod = 'business_card' | 'cash_personal' | 'bank_transfer' | 'not_applicable';
export type PaymentMethodMatchState = 'not_detected' | 'personal' | 'company_card' | 'employee_review' | 'employee_exception';
export type InboxStatus = 'Processing' | 'Ready' | 'Review' | 'Published' | 'Payment processing' | 'Paid' | 'Rejected';
export type ReceiptSource = 'mobile' | 'email' | 'web_upload' | 'bank_import';

export type UserRole = 'Business_Admin' | 'Standard_Employee';
export type UserStatus = 'pending_invite' | 'pending_confirmation' | 'active';
export type UkTaxRate = '20% Standard' | '5% Reduced' | '0% Zero' | 'Exempt' | 'No VAT';
export type UkVatTreatment =
  | 'not_applicable'
  | 'no_uk_vat_to_reclaim'
  | 'uk_vat_included'
  | 'reverse_charge_required'
  | 'import_vat'
  | 'accountant_review';
export type BillingPlanId = 'capture' | 'control' | 'operations' | 'enterprise' | 'legacy';
export type BillingStatus = 'trialing' | 'active' | 'past_due' | 'canceled' | 'inactive' | 'legacy';
export type BillingCycle = 'monthly' | 'annual' | 'custom';

export type ExpenseRequestOptions = {
  locale: string;
  extractLineItems: boolean;
  documentType: DocumentType;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  skipProcessing: boolean;
};

export type NormalizedExpenseDocument = {
  vendorName: string | null;
  customer: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  paymentCardLastFour: string | null;
  paymentCardNetwork: string | null;
  paymentCardIssuer: string | null;
  currency: string | null;
  baseCurrency?: string;
  exchangeRate?: number | null;
  exchangeRateDate?: string | null;
  exchangeRateProvider?: string | null;
  baseTotalAmount?: number | null;
  exchangeRateOverride?: boolean;
  exchangeRateNote?: string | null;
  totalAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  taxRateApplied: UkTaxRate | string | null;
  subtotalAmount: number | null;
  totalTaxAmount: number | null;
  foreignTaxAmount?: number | null;
  foreignTaxLabel?: string | null;
  ukVatTreatment?: UkVatTreatment;
  documentType: DocumentType;
  confidenceScore: number | null;
  confidenceSource: 'model_self_assessment' | 'unavailable';
  needsReview: boolean;
  lineItems: Array<{
    description: string;
    quantity: number | null;
    unitPrice: number | null;
    total: number | null;
    taxAmount: number | null;
  }>;
  taxBreakdown: Array<{
    label: string;
    rate: number | null;
    amount: number | null;
  }>;
  notes: string[];
  rawTextSummary: string | null;
};

export type ReceiptRow = {
  id: number;
  organisationId: number;
  uploadedByUserId: number;
  uploadedByName?: string | null;
  uploadedByEmail?: string | null;
  uploadedByDepartmentId?: number | null;
  uploadedByDepartmentName?: string | null;
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  paymentMethodMatchState: PaymentMethodMatchState;
  paymentMethodReviewRequired: boolean;
  matchedCompanyCardId: number | null;
  claimId: number | null;
  // Mileage is stored as structured journey evidence, not as a receipt. It is
  // projected into the Costs inbox with this link so it follows the same cost
  // review queue without entering OCR, VAT, or receipt reimbursement flows.
  mileageClaimId?: number | null;
  status: InboxStatus;
  category: string | null;
  description: string | null;
  customer: string | null;
  receiptSource: ReceiptSource;
  sourceFilename: string;
  sourceMimeType: string;
  contentSha256?: string | null;
  s3Bucket: string;
  s3Key: string;
  locale: string;
  documentType: DocumentType;
  vendorName: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  paymentCardLastFour: string | null;
  paymentCardNetwork: string | null;
  paymentCardIssuer: string | null;
  currency: string | null;
  baseCurrency: string;
  exchangeRate: number | null;
  exchangeRateDate: string | null;
  exchangeRateProvider: string | null;
  baseTotalAmount: number | null;
  exchangeRateOverride: boolean;
  exchangeRateNote: string | null;
  totalAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  taxRateApplied: UkTaxRate | string | null;
  subtotalAmount: number | null;
  totalTaxAmount: number | null;
  foreignTaxAmount: number | null;
  foreignTaxLabel: string | null;
  ukVatTreatment: UkVatTreatment;
  reimbursementBatchId: string | null;
  reimbursementBatchCreatedAt: string | null;
  confidenceScore: number | null;
  confidenceSource: 'model_self_assessment' | 'unavailable';
  needsReview: boolean;
  extractionProvider: string;
  extractionModel: string;
  lineItems: NormalizedExpenseDocument['lineItems'];
  taxBreakdown: NormalizedExpenseDocument['taxBreakdown'];
  notes: string[];
  rawTextSummary: string | null;
  createdAt: string;
  updatedAt: string;
};

export type DepartmentRow = {
  id: number;
  organisationId: number;
  name: string;
  managerUserId: number | null;
  managerName?: string | null;
};

export type TeamMemberRow = {
  id: number;
  organisationId: number;
  email: string;
  fullName: string | null;
  role: UserRole;
  status: UserStatus;
  departmentId: number | null;
  departmentName: string | null;
  invitedByUserId: number | null;
};

export type ExpenseClaimRow = {
  id: number;
  organisationId: number;
  createdByUserId: number;
  name: string;
  description: string | null;
  currency: string;
  status: 'pending' | 'approved' | 'published' | 'payment_processing' | 'paid' | 'rejected';
  totalAmount: number;
  documentCount: number;
  claimType?: 'standard' | 'mileage';
  mileageStartPostcode?: string | null;
  mileageEndPostcode?: string | null;
  mileageTotalMiles?: number | null;
  mileageRate?: number | null;
  mileageTotalAmount?: number | null;
  claimantName?: string | null;
  claimantEmail?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ClaimEvidenceRow = {
  id: string;
  organisationId: number;
  claimId: number;
  uploadedByUserId: number;
  sourceFilename: string;
  sourceMimeType: string;
  s3Key: string;
  createdAt: string;
};

export type SupplierRuleRow = {
  id: number;
  organisationId: number;
  workspaceContext: 'cost' | 'sales';
  supplierMatchText: string;
  category: string;
  taxRate: string;
  paymentMethod: PaymentMethod;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CompanyCardRow = {
  id: number;
  organisationId: number;
  label: string;
  cardNetwork: string | null;
  cardIssuer: string | null;
  lastFour: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type CompanyCardEmployeeExceptionRow = {
  id: number;
  organisationId: number;
  companyCardId: number;
  employeeUserId: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
};

export type BankTransactionRow = {
  id: number;
  organisationId: number;
  transactionId: string;
  bookingDate: string;
  remittanceInformation: string;
  transactionAmount: number;
  status: 'Open' | 'Audited';
  matchedReceiptId: number | null;
  createdAt: string;
  updatedAt: string;
};

export type BankRequisitionRow = {
  id: number;
  organisationId: number;
  provider: string;
  externalRequisitionId: string;
  institutionId: string | null;
  status: 'pending' | 'linked' | 'failed';
  redirectUrl: string;
  callbackState: string;
  createdAt: string;
  updatedAt: string;
};

export type ReconciliationCandidate = Pick<
  ReceiptRow,
  'id' | 'vendorName' | 'invoiceDate' | 'totalAmount' | 'status' | 'category' | 'receiptSource'
> & {
  matchScore: number;
};

export type OrganisationSettings = {
  organisationId: number;
  organisationName: string;
  baseCurrency: string;
  isVatRegistered: boolean;
  defaultTaxRate: string;
  mileageRate: number;
};

export type OrganisationBillingSummary = {
  planId: BillingPlanId;
  status: BillingStatus;
  billingCycle: BillingCycle;
  trialEndsAt: string | null;
  billingPeriodStartedAt: string | null;
  billingPeriodEndsAt: string | null;
  monthlyDocumentLimit: number | null;
  monthlyDocumentUsage: number;
  includedUsers: number | null;
  currentUserCount: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  cancellationScheduledFor: string | null;
};

export type AuthenticatedUser = {
  id: number;
  organisationId: number;
  email: string;
  fullName: string | null;
  role: UserRole;
  status: UserStatus;
  emailConfirmationDueAt?: string | null;
};

export type UserRecord = AuthenticatedUser & {
  passwordHash: string | null;
  inviteToken: string | null;
  invitedByUserId: number | null;
  departmentId?: number | null;
  createdAt?: string | null;
  emailConfirmationGraceStartedAt?: string | null;
};
