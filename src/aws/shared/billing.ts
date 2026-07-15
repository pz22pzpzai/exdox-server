import { awsEnv } from './env.js';
import {
  type BillingCycle,
  type BillingPlanId,
  type BillingStatus,
  type OrganisationBillingSummary,
  type UserRole,
  type WorkspaceContext,
} from '../types.js';

export type PlanDefinition = {
  id: BillingPlanId;
  label: string;
  monthlyDocumentLimit: number | null;
  includedUsers: number | null;
  routes: string[];
  features: string[];
  trialDays: number | null;
  highlight?: string;
};

const ACTIVE_BILLING_STATUSES = new Set<BillingStatus>(['trialing', 'active', 'legacy']);

const PLAN_DEFINITIONS: Record<BillingPlanId, PlanDefinition> = {
  capture: {
    id: 'capture',
    label: 'Capture',
    monthlyDocumentLimit: 250,
    includedUsers: 5,
    routes: ['/overview', '/costs', '/claims', '/settings', '/billing'],
    features: [
      'mobile_capture',
      'web_upload',
      'cost_review',
      'employee_dropbox',
      'expense_claims',
      'tax_editing',
      'data_health',
    ],
    trialDays: 14,
    highlight: 'Receipt capture and review',
  },
  control: {
    id: 'control',
    label: 'Control',
    monthlyDocumentLimit: 1250,
    includedUsers: 25,
    routes: ['/overview', '/costs', '/sales', '/claims', '/settings', '/billing'],
    features: [
      'mobile_capture',
      'web_upload',
      'cost_review',
      'sales_review',
      'employee_dropbox',
      'expense_claims',
      'tax_editing',
      'data_health',
      'approval_workflows',
      'queue_exports',
    ],
    trialDays: 14,
    highlight: 'Costs, sales, and approvals',
  },
  operations: {
    id: 'operations',
    label: 'Operations',
    monthlyDocumentLimit: 10000,
    includedUsers: 100,
    routes: [
      '/overview',
      '/costs',
      '/sales',
      '/vault',
      '/claims',
      '/rules',
      '/reconciliation',
      '/settings',
      '/requisitions',
      '/bank-callback',
      '/billing',
    ],
    features: [
      'mobile_capture',
      'web_upload',
      'cost_review',
      'sales_review',
      'employee_dropbox',
      'expense_claims',
      'tax_editing',
      'data_health',
      'approval_workflows',
      'queue_exports',
      'supplier_rules',
      'vault',
      'reconciliation',
      'open_banking',
      'archive_access',
    ],
    trialDays: 14,
    highlight: 'Rules, vault, and bank matching',
  },
  enterprise: {
    id: 'enterprise',
    label: 'Enterprise',
    monthlyDocumentLimit: null,
    includedUsers: null,
    routes: [
      '/overview',
      '/costs',
      '/sales',
      '/vault',
      '/claims',
      '/rules',
      '/reconciliation',
      '/settings',
      '/requisitions',
      '/bank-callback',
      '/billing',
    ],
    features: [
      'mobile_capture',
      'web_upload',
      'cost_review',
      'sales_review',
      'employee_dropbox',
      'expense_claims',
      'tax_editing',
      'data_health',
      'approval_workflows',
      'queue_exports',
      'supplier_rules',
      'vault',
      'reconciliation',
      'open_banking',
      'archive_access',
      'multi_entity',
      'priority_support',
    ],
    trialDays: 30,
    highlight: 'Custom rollout and multi-entity support',
  },
  legacy: {
    id: 'legacy',
    label: 'Legacy',
    monthlyDocumentLimit: null,
    includedUsers: null,
    routes: [
      '/overview',
      '/costs',
      '/sales',
      '/vault',
      '/claims',
      '/rules',
      '/reconciliation',
      '/settings',
      '/requisitions',
      '/bank-callback',
      '/billing',
    ],
    features: [
      'mobile_capture',
      'web_upload',
      'cost_review',
      'sales_review',
      'employee_dropbox',
      'expense_claims',
      'tax_editing',
      'data_health',
      'approval_workflows',
      'queue_exports',
      'supplier_rules',
      'vault',
      'reconciliation',
      'open_banking',
      'archive_access',
      'multi_entity',
      'priority_support',
    ],
    trialDays: null,
  },
};

export function getPlanDefinition(planId: BillingPlanId) {
  return PLAN_DEFINITIONS[planId] ?? PLAN_DEFINITIONS.legacy;
}

export function normalizePlanId(value: unknown): BillingPlanId {
  return value === 'capture' || value === 'control' || value === 'operations' || value === 'enterprise'
    ? value
    : 'legacy';
}

export function normalizeBillingCycle(value: unknown): BillingCycle {
  return value === 'annual' || value === 'custom' ? value : 'monthly';
}

export function normalizeBillingStatus(value: unknown, planId: BillingPlanId): BillingStatus {
  if (value === 'trialing' || value === 'active' || value === 'past_due' || value === 'canceled' || value === 'inactive') {
    return value;
  }
  return planId === 'legacy' ? 'legacy' : 'trialing';
}

export function defaultTrialEndsAt(planId: BillingPlanId) {
  const days = getPlanDefinition(planId).trialDays;
  if (!days) {
    return null;
  }
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function resolveAllowedWebRoutes(summary: OrganisationBillingSummary, role: UserRole) {
  if (role !== 'Business_Admin') {
    return ['/dropbox'];
  }

  const definition = getPlanDefinition(summary.planId);
  if (!isBillingActive(summary)) {
    return ['/billing', '/settings'];
  }

  return definition.routes;
}

export function isBillingActive(summary: OrganisationBillingSummary) {
  return ACTIVE_BILLING_STATUSES.has(summary.status);
}

export function hasFeature(summary: OrganisationBillingSummary, feature: string) {
  return isBillingActive(summary) && getPlanDefinition(summary.planId).features.includes(feature);
}

export function canInviteUser(summary: OrganisationBillingSummary) {
  return summary.includedUsers === null || summary.currentUserCount < summary.includedUsers;
}

export function canProcessDocument(summary: OrganisationBillingSummary) {
  return summary.monthlyDocumentLimit === null || summary.monthlyDocumentUsage < summary.monthlyDocumentLimit;
}

export function getPlanLimitMessage(summary: OrganisationBillingSummary, kind: 'documents' | 'users') {
  const definition = getPlanDefinition(summary.planId);
  if (kind === 'documents') {
    return `${definition.label} includes ${summary.monthlyDocumentLimit ?? 'custom'} documents per month. Upgrade or wait for the next cycle to continue extraction.`;
  }
  return `${definition.label} includes ${summary.includedUsers ?? 'custom'} users. Upgrade the plan to invite more teammates.`;
}

export function buildEntitlements(summary: OrganisationBillingSummary) {
  const definition = getPlanDefinition(summary.planId);
  return {
    features: definition.features,
    lockedRoutes: getAllPlanRoutes().filter((route) => !resolveAllowedWebRoutes(summary, 'Business_Admin').includes(route)),
  };
}

export function canAccessWorkspace(summary: OrganisationBillingSummary, workspace: WorkspaceContext) {
  if (!isBillingActive(summary)) {
    return false;
  }
  if (workspace === 'cost') {
    return true;
  }
  if (workspace === 'sales') {
    return hasFeature(summary, 'sales_review');
  }
  return hasFeature(summary, 'vault');
}

export function getAccessibleWorkspaces(summary: OrganisationBillingSummary) {
  return (['cost', 'sales', 'vault'] as WorkspaceContext[]).filter((workspace) => canAccessWorkspace(summary, workspace));
}

export function assertWorkspaceAccess(summary: OrganisationBillingSummary, workspace: WorkspaceContext) {
  if (canAccessWorkspace(summary, workspace)) {
    return;
  }
  throw billingLockedError(
    workspace === 'sales'
      ? 'Your current plan does not include the sales workspace.'
      : workspace === 'vault'
        ? 'Your current plan does not include the vault workspace.'
        : 'Your current plan does not include this workspace.',
  );
}

export function assertFeatureAccess(summary: OrganisationBillingSummary, feature: string, message: string) {
  if (hasFeature(summary, feature)) {
    return;
  }
  throw billingLockedError(message);
}

export function listPlanDefinitions() {
  return Object.values(PLAN_DEFINITIONS);
}

function getAllPlanRoutes() {
  return Array.from(new Set(Object.values(PLAN_DEFINITIONS).flatMap((plan) => plan.routes)));
}

export function isStripeConfigured() {
  return Boolean(awsEnv.stripeSecretKey);
}

export function getStripePriceId(planId: BillingPlanId, billingCycle: BillingCycle) {
  if (billingCycle === 'custom' || planId === 'legacy') {
    return null;
  }

  const map: Record<string, string | null> = {
    'capture:monthly': awsEnv.stripePriceCaptureMonthly,
    'capture:annual': awsEnv.stripePriceCaptureAnnual,
    'control:monthly': awsEnv.stripePriceControlMonthly,
    'control:annual': awsEnv.stripePriceControlAnnual,
    'operations:monthly': awsEnv.stripePriceOperationsMonthly,
    'operations:annual': awsEnv.stripePriceOperationsAnnual,
    'enterprise:monthly': awsEnv.stripePriceEnterpriseMonthly,
    'enterprise:annual': awsEnv.stripePriceEnterpriseAnnual,
  };

  return map[`${planId}:${billingCycle}`] ?? null;
}

function billingLockedError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 402;
  error.code = 'plan_locked';
  return error;
}
