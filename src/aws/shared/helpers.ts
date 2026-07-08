import { type DocumentType, type ExpenseRequestOptions, type PaymentMethod, type WorkspaceContext } from '../types.js';

export function sanitizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

export function parseBoolean(value: unknown, fallback: boolean) {
  if (typeof value !== 'string') {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

export function parseDocumentType(value: unknown): DocumentType {
  if (value === 'receipt' || value === 'invoice') {
    return value;
  }
  return 'unknown';
}

export function parseWorkspaceContext(value: unknown): WorkspaceContext {
  if (value === 'sales') {
    return 'sales';
  }
  if (value === 'vault') {
    return 'vault';
  }
  return 'cost';
}

export function parsePaymentMethod(value: unknown, fallback: PaymentMethod = 'business_card'): PaymentMethod {
  if (value === 'cash_personal' || value === 'business_card' || value === 'bank_transfer' || value === 'not_applicable') {
    return value;
  }
  return fallback;
}

export function normalizeDateString(value: unknown) {
  const text = sanitizeText(value);
  if (!text) {
    return null;
  }

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

export function normalizeCurrencyCode(value: unknown) {
  const text = sanitizeText(value).toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

export function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

export function clampConfidence(value: number | null) {
  if (value === null) {
    return null;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

export function inferMimeType(fileName: string) {
  if (/\.pdf$/i.test(fileName)) {
    return 'application/pdf';
  }
  if (/\.png$/i.test(fileName)) {
    return 'image/png';
  }
  if (/\.webp$/i.test(fileName)) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

export function readRequestOptions(input: Record<string, string | undefined>): ExpenseRequestOptions {
  const workspaceContext = parseWorkspaceContext(input.workspace_context);
  const defaultPaymentMethod =
    workspaceContext === 'vault' ? 'not_applicable' : workspaceContext === 'sales' ? 'bank_transfer' : 'business_card';
  return {
    locale: sanitizeText(input.locale) || 'en-GB',
    extractLineItems: parseBoolean(input.extract_line_items, true),
    documentType: parseDocumentType(input.document_type),
    workspaceContext,
    paymentMethod: parsePaymentMethod(input.payment_method, defaultPaymentMethod),
    skipProcessing: parseBoolean(input.skip_processing, workspaceContext === 'vault'),
  };
}
