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

export type SelfServeSubscriptionSelection = {
  planId: Extract<BillingPlanId, 'capture' | 'control' | 'operations'>;
  monthlyDocumentLimit: number;
  includedUsers: number;
  monthlyAmountPence: number;
  label: string;
};

const ACTIVE_BILLING_STATUSES = new Set<BillingStatus>(['trialing', 'active', 'legacy']);

const PLAN_DEFINITIONS: Record<BillingPlanId, PlanDefinition> = {
  capture: {
    id: 'capture',
    label: 'Capture',
    monthlyDocumentLimit: 250,
    includedUsers: 5,
    routes: ['/overview', '/costs', '/sales', '/claims', '/company-cards', '/settings', '/billing'],
    features: [
      'mobile_capture',
      'web_upload',
      'cost_review',
      'sales_review',
      'employee_dropbox',
      'expense_claims',
      'approval_workflows',
      'queue_exports',
      'tax_editing',
      'data_health',
    ],
    trialDays: 14,
    highlight: 'Receipt capture and review',
  },
  control: {
    id: 'control',
    label: 'Control',
    monthlyDocumentLimit: 1500,
    includedUsers: 30,
    routes: ['/overview', '/costs', '/sales', '/claims', '/company-cards', '/settings', '/billing'],
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
    monthlyDocumentLimit: 3000,
    includedUsers: 60,
    routes: [
      '/overview',
      '/costs',
      '/sales',
      '/vault',
      '/claims',
      '/rules',
      '/company-cards',
      '/settings',
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
      'archive_access',
    ],
    trialDays: 14,
    highlight: 'Rules, vault, and expanded review controls',
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
      '/company-cards',
      '/settings',
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
      '/company-cards',
      '/settings',
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
    if (!isBillingActive(summary)) {
      // Employees cannot access company records after the organisation's access
      // ends, but can still reach support from the signed-in workspace shell.
      return ['/contact'];
    }

    const definition = getPlanDefinition(summary.planId);
    const routes = ['/dropbox', '/claims', '/employee/reports'];
    if (definition.routes.includes('/sales')) {
      routes.push('/employee/sales');
    }
    if (definition.routes.includes('/vault')) {
      routes.push('/employee/vault');
    }
    return routes;
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

export function resolveSelfServeSubscriptionSelection(input: {
  planId: BillingPlanId;
  monthlyDocumentLimit?: number | null;
  includedUsers?: number | null;
}): SelfServeSubscriptionSelection {
  const includedUsers = Number(input.includedUsers);
  const monthlyDocumentLimit = Number(input.monthlyDocumentLimit);
  const isFiveUserIncrement = Number.isInteger(includedUsers) && includedUsers % 5 === 0;
  const hasExpectedDocumentAllowance = monthlyDocumentLimit === includedUsers * 50;

  if (!isFiveUserIncrement || !hasExpectedDocumentAllowance) {
    throw invalidSubscriptionSelectionError();
  }

  if (input.planId === 'capture' && includedUsers >= 5 && includedUsers <= 25) {
    return buildSelfServeSelection('capture', includedUsers, monthlyDocumentLimit, includedUsers * 300);
  }

  if (input.planId === 'control' && includedUsers >= 30 && includedUsers <= 55) {
    return buildSelfServeSelection('control', includedUsers, monthlyDocumentLimit, 7500 + ((includedUsers - 25) / 5) * 1400);
  }

  if (input.planId === 'operations' && includedUsers >= 60 && includedUsers <= 100) {
    const monthlyAmountPence = includedUsers <= 80
      ? 17300 + ((includedUsers - 60) / 5) * 1441
      : 23062 + ((includedUsers - 80) / 5) * 1441;
    return buildSelfServeSelection('operations', includedUsers, monthlyDocumentLimit, monthlyAmountPence);
  }

  throw invalidSubscriptionSelectionError();
}

function buildSelfServeSelection(
  planId: SelfServeSubscriptionSelection['planId'],
  includedUsers: number,
  monthlyDocumentLimit: number,
  monthlyAmountPence: number,
): SelfServeSubscriptionSelection {
  return {
    planId,
    includedUsers,
    monthlyDocumentLimit,
    monthlyAmountPence: Math.round(monthlyAmountPence),
    label: `${getPlanDefinition(planId).label} - ${includedUsers} users`,
  };
}

function invalidSubscriptionSelectionError() {
  const error = new Error('The selected plan allowance is not available. Return to Pricing and choose a published package.');
  (error as Error & { statusCode?: number; code?: string }).statusCode = 400;
  (error as Error & { statusCode?: number; code?: string }).code = 'invalid_subscription_selection';
  return error;
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

export function getPlanIdFromStripePriceId(priceId: string | null | undefined): BillingPlanId | null {
  if (!priceId) {
    return null;
  }

  const map: Record<string, BillingPlanId> = {
    [awsEnv.stripePriceCaptureMonthly || '']: 'capture',
    [awsEnv.stripePriceCaptureAnnual || '']: 'capture',
    [awsEnv.stripePriceControlMonthly || '']: 'control',
    [awsEnv.stripePriceControlAnnual || '']: 'control',
    [awsEnv.stripePriceOperationsMonthly || '']: 'operations',
    [awsEnv.stripePriceOperationsAnnual || '']: 'operations',
    [awsEnv.stripePriceEnterpriseMonthly || '']: 'enterprise',
    [awsEnv.stripePriceEnterpriseAnnual || '']: 'enterprise',
  };

  return map[priceId] ?? null;
}

function billingLockedError(message: string) {
  const error = new Error(message) as Error & { statusCode?: number; code?: string };
  error.statusCode = 402;
  error.code = 'plan_locked';
  return error;
}
