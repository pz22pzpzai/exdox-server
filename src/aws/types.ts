export type DocumentType = 'receipt' | 'invoice' | 'unknown';
export type WorkspaceContext = 'cost' | 'sales' | 'vault';
export type PaymentMethod = 'business_card' | 'cash_personal' | 'bank_transfer' | 'not_applicable';
export type InboxStatus = 'Processing' | 'Ready' | 'Review' | 'Published';
export type ReceiptSource = 'mobile' | 'email' | 'web_upload' | 'bank_import';

export type UserRole = 'Business_Admin' | 'Standard_Employee';
export type UserStatus = 'pending_invite' | 'active';
export type UkTaxRate = '20% Standard' | '5% Reduced' | '0% Zero' | 'Exempt' | 'No VAT';
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
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string | null;
  totalAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  taxRateApplied: UkTaxRate | string | null;
  subtotalAmount: number | null;
  totalTaxAmount: number | null;
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
  workspaceContext: WorkspaceContext;
  paymentMethod: PaymentMethod;
  claimId: number | null;
  status: InboxStatus;
  category: string | null;
  description: string | null;
  customer: string | null;
  receiptSource: ReceiptSource;
  sourceFilename: string;
  sourceMimeType: string;
  s3Bucket: string;
  s3Key: string;
  locale: string;
  documentType: DocumentType;
  vendorName: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string | null;
  totalAmount: number | null;
  netAmount: number | null;
  vatAmount: number | null;
  taxRateApplied: UkTaxRate | string | null;
  subtotalAmount: number | null;
  totalTaxAmount: number | null;
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

export type ExpenseClaimRow = {
  id: number;
  organisationId: number;
  createdByUserId: number;
  name: string;
  description: string | null;
  currency: string;
  status: 'pending' | 'approved' | 'paid' | 'rejected';
  totalAmount: number;
  documentCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SupplierRuleRow = {
  id: number;
  organisationId: number;
  supplierMatchText: string;
  category: string;
  taxRate: string;
  paymentMethod: PaymentMethod;
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
  isVatRegistered: boolean;
  defaultTaxRate: string;
};

export type OrganisationBillingSummary = {
  planId: BillingPlanId;
  status: BillingStatus;
  billingCycle: BillingCycle;
  trialEndsAt: string | null;
  monthlyDocumentLimit: number | null;
  monthlyDocumentUsage: number;
  includedUsers: number | null;
  currentUserCount: number;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

export type AuthenticatedUser = {
  id: number;
  organisationId: number;
  email: string;
  fullName: string | null;
  role: UserRole;
  status: UserStatus;
};

export type UserRecord = AuthenticatedUser & {
  passwordHash: string | null;
  inviteToken: string | null;
  invitedByUserId: number | null;
};
