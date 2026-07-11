import OpenAI from 'openai';

import { awsEnv } from './env.js';
import {
  clampConfidence,
  inferMimeType,
  normalizeCurrencyCode,
  normalizeDateString,
  parseDocumentType,
  sanitizeText,
  toNumber,
} from './helpers.js';
import { type DocumentType, type ExpenseRequestOptions, type NormalizedExpenseDocument } from '../types.js';

const openai = new OpenAI({
  apiKey: awsEnv.openAiApiKey,
  timeout: 45000,
});

export async function processExpenseBuffer(input: {
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
  options: ExpenseRequestOptions;
}) {
  const responseText = await extractWithOpenAI(input);
  const raw = parseExtractionJson(responseText);
  const didRetryVat = shouldRetryVatExtraction(raw);
  const vatFallbackRaw = didRetryVat ? parseExtractionJson(await extractVatFallbackWithOpenAI(input, raw)) : null;
  const mergedRaw = vatFallbackRaw ? mergeExtractionPayloads(raw, vatFallbackRaw) : raw;
  const normalized = normalizeExtractionPayload(mergedRaw, input.options.documentType);

  console.info(
    '[vat-debug]',
    JSON.stringify({
      fileName: input.fileName,
      documentType: input.options.documentType,
      didRetryVat,
      firstPass: summarizeVatDebugPayload(raw),
      vatFallback: summarizeVatDebugPayload(vatFallbackRaw),
      merged: summarizeVatDebugPayload(mergedRaw),
      normalized: {
        totalAmount: normalized.totalAmount,
        netAmount: normalized.netAmount,
        vatAmount: normalized.vatAmount,
        totalTaxAmount: normalized.totalTaxAmount,
        taxRateApplied: normalized.taxRateApplied,
        notes: normalized.notes.slice(0, 4),
      },
    }),
  );

  return normalized;
}

async function extractWithOpenAI({
  fileName,
  mimeType,
  buffer,
  options,
}: {
  fileName: string;
  mimeType?: string;
  buffer: Buffer;
  options: ExpenseRequestOptions;
}) {
  const resolvedMimeType = mimeType || inferMimeType(fileName);
  const inputContent: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: buildExtractionPrompt(options),
    },
  ];

  if (resolvedMimeType === 'application/pdf') {
    const uploadedFile = await openai.files.create({
      file: new File([new Uint8Array(buffer)], fileName, { type: resolvedMimeType }),
      purpose: 'user_data',
    });

    inputContent.push({
      type: 'input_file',
      file_id: uploadedFile.id,
    });
  } else {
    inputContent.push({
      type: 'input_image',
      image_url: `data:${resolvedMimeType};base64,${buffer.toString('base64')}`,
      detail: 'high',
    });
  }

  const response = await openai.responses.create({
    model: awsEnv.openAiModel,
    input: [
      {
        role: 'user',
        content: inputContent as never,
      },
    ],
  });

  if (!response.output_text) {
    throw new Error('The OCR provider returned an empty response.');
  }

  return response.output_text;
}

async function extractVatFallbackWithOpenAI(
  input: {
    fileName: string;
    mimeType?: string;
    buffer: Buffer;
    options: ExpenseRequestOptions;
  },
  firstPassRaw: unknown,
) {
  const resolvedMimeType = input.mimeType || inferMimeType(input.fileName);
  const inputContent: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: buildVatFallbackPrompt(input.options, firstPassRaw),
    },
  ];

  if (resolvedMimeType === 'application/pdf') {
    const uploadedFile = await openai.files.create({
      file: new File([new Uint8Array(input.buffer)], input.fileName, { type: resolvedMimeType }),
      purpose: 'user_data',
    });

    inputContent.push({
      type: 'input_file',
      file_id: uploadedFile.id,
    });
  } else {
    inputContent.push({
      type: 'input_image',
      image_url: `data:${resolvedMimeType};base64,${input.buffer.toString('base64')}`,
      detail: 'high',
    });
  }

  const response = await openai.responses.create({
    model: awsEnv.openAiModel,
    input: [
      {
        role: 'user',
        content: inputContent as never,
      },
    ],
  });

  if (!response.output_text) {
    throw new Error('The OCR provider returned an empty VAT fallback response.');
  }

  return response.output_text;
}

function buildExtractionPrompt(options: ExpenseRequestOptions): string {
  return [
    'Read this receipt or invoice and return valid JSON only.',
    'Do not wrap the JSON in markdown fences.',
    'This is an OCR-style extraction task. Prefer literal reading over inference.',
    'Do not guess missing values, names, dates, or amounts.',
    'If the image is blank, dark, heavily blurred, out of focus, or does not clearly show a receipt or invoice, treat it as unreadable and do not invent any values.',
    'For an unreadable image, return vendor_name as null, total_amount as null, net_amount as null, vat_amount as null, subtotal_amount as null, total_tax_amount as null, raw_text_summary as "Could not read receipt or invoice.", and include the note "Could not read receipt or invoice."',
    'Carefully inspect the entire image, especially the header and the lower summary area where totals are usually printed.',
    'For receipts, find the final amount actually paid or charged.',
    'For invoices, find the invoice total due or balance due.',
    'Prioritize labels such as TOTAL, AMOUNT DUE, BALANCE DUE, GRAND TOTAL, CARD PAYMENT, PAID, or TO PAY.',
    'Do not confuse subtotal, VAT, tax, tip, discount, change, or item prices with the final total amount.',
    'If multiple amounts are visible, choose the final payable amount only when the label or placement clearly supports it.',
    'Only return total_amount when the amount itself and a nearby total-style label are both visible on the document.',
    'Never use a lone price, item amount, subtotal, VAT value, or an unlabeled number as total_amount.',
    'If the document shows several numbers and no final payable label can be read clearly, return total_amount as null.',
    'If the total amount is not clearly visible or cannot be read confidently, return total_amount as null.',
    'Extract UK VAT fields separately: total_amount is gross paid, vat_amount is VAT/tax, and net_amount is before VAT.',
    'If VAT is printed, return vat_amount exactly as printed.',
    'Only return vat_amount when the document clearly shows a VAT or TAX label, amount, or an explicit printed VAT/tax rate.',
    'Never invent vat_amount from merchant type, product type, or a guessed standard rate.',
    'If the receipt explicitly prints a VAT or tax rate such as VAT 20% or Tax 5% but does not print the VAT amount, return printed_vat_rate_percent with that numeric rate.',
    'Only calculate missing vat_amount when the document explicitly shows a VAT or tax rate. Do not calculate VAT from a guessed or inferred rate.',
    'If net_amount is missing but total_amount and vat_amount are clear, calculate net_amount as total_amount - vat_amount.',
    'If VAT is not printed and cannot be reliably inferred, return vat_amount as null.',
    'Only return suggested_uk_tax_rate when the receipt explicitly prints a VAT/TAX rate, or when total_amount, net_amount, and vat_amount are all clearly visible and support an exact UK VAT rate.',
    'Never set suggested_uk_tax_rate from merchant type, merchant brand, item category, or general business knowledge alone.',
    'If subtotal is not clearly visible, return subtotal_amount as the same value as net_amount when net_amount is known, otherwise null.',
    'If tax is not clearly visible, return total_tax_amount as the same value as vat_amount when vat_amount is known, otherwise null.',
    'Use the printed currency symbol or currency code on the document when visible. Convert symbols to ISO code, for example £ to GBP, $ to USD, and € to EUR.',
    'The vendor name must come from the document itself, usually the top header or merchant branding. Never invent a workspace name or a filename-based name.',
    'The invoice number must be a literal printed reference number from the document, not a filename or timestamp.',
    'When total_amount is not null, total_evidence_text must contain the exact visible total label and amount snippet from the document.',
    'When the final total cannot be proven from the document, set total_evidence_text to null.',
    'When vat_amount is not null, vat_evidence_text must contain the exact visible VAT or TAX snippet from the document.',
    'When printed_vat_rate_percent is not null, vat_rate_evidence_text must contain the exact visible VAT or TAX rate snippet from the document.',
    'When VAT or tax cannot be proven from the document, set vat_evidence_text and vat_rate_evidence_text to null.',
    'The raw_text_summary must be a short plain-English summary of what is actually visible on the document. Preserve the correct currency symbol and do not invent values.',
    `Locale for date and number interpretation: ${options.locale}.`,
    `Document type hint: ${options.documentType}.`,
    `Extract line items: ${options.extractLineItems ? 'yes' : 'no'}.`,
    'Return this shape exactly:',
    JSON.stringify(
      {
        vendor_name: 'string | null',
        invoice_date: 'YYYY-MM-DD | null',
        due_date: 'YYYY-MM-DD | null',
        invoice_number: 'string | null',
        currency: 'ISO 4217 code like GBP, USD, EUR | null',
        total_amount: 'number | null',
        total_evidence_text: 'string | null',
        net_amount: 'number | null',
        vat_amount: 'number | null',
        vat_evidence_text: 'string | null',
        printed_vat_rate_percent: 'number | null',
        vat_rate_evidence_text: 'string | null',
        suggested_uk_tax_rate: '20% Standard | 5% Reduced | 0% Zero | Exempt | null',
        subtotal_amount: 'number | null',
        total_tax_amount: 'number | null',
        document_type: 'receipt | invoice | unknown',
        confidence_score: 'number from 0 to 1 | null',
        notes: ['string'],
        raw_text_summary: 'string | null',
        line_items: [
          {
            description: 'string',
            quantity: 'number | null',
            unit_price: 'number | null',
            total: 'number | null',
            tax_amount: 'number | null',
          },
        ],
        tax_breakdown: [
          {
            label: 'string',
            rate: 'number | null',
            amount: 'number | null',
          },
        ],
      },
      null,
      2,
    ),
  ].join('\n');
}

function buildVatFallbackPrompt(options: ExpenseRequestOptions, firstPassRaw: unknown): string {
  return [
    'Re-read this same receipt or invoice, but only for VAT and tax evidence.',
    'Return valid JSON only. Do not wrap the JSON in markdown fences.',
    'Look carefully at the lower summary block where receipts often print VAT breakdowns, VAT numbers, tax codes, subtotal, and total.',
    'Do not guess VAT from the merchant type alone.',
    'If the receipt prints a VAT amount, return that exact amount.',
    'If the receipt prints a VAT or tax percentage but not the VAT amount, return the printed_vat_rate_percent.',
    'If the receipt prints a subtotal or net amount before VAT, return net_amount and subtotal_amount exactly as visible.',
    'If a VAT amount is clearly printed, also return total_tax_amount with the same number.',
    'If there is no visible VAT or tax line, return all VAT fields as null and explain that briefly in notes.',
    'Use exact visible snippets for vat_evidence_text and vat_rate_evidence_text.',
    `Locale for date and number interpretation: ${options.locale}.`,
    `Document type hint: ${options.documentType}.`,
    'Here is the first pass result for context. Correct it if VAT was missed:',
    JSON.stringify(firstPassRaw, null, 2),
    'Return this shape exactly:',
    JSON.stringify(
      {
        net_amount: 'number | null',
        vat_amount: 'number | null',
        vat_evidence_text: 'string | null',
        printed_vat_rate_percent: 'number | null',
        vat_rate_evidence_text: 'string | null',
        subtotal_amount: 'number | null',
        total_tax_amount: 'number | null',
        tax_breakdown: [
          {
            label: 'string',
            rate: 'number | null',
            amount: 'number | null',
          },
        ],
        notes: ['string'],
        raw_text_summary: 'string | null',
      },
      null,
      2,
    ),
  ].join('\n');
}

function parseExtractionJson(responseText: string): unknown {
  const trimmed = responseText.trim();
  const cleaned = trimmed.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('The OCR provider returned invalid JSON.');
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

function summarizeVatDebugPayload(raw: unknown) {
  if (typeof raw !== 'object' || !raw) {
    return null;
  }

  const source = raw as Record<string, unknown>;
  const notes = Array.isArray(source.notes)
    ? source.notes
        .map((note) => normalizeFreeText(note))
        .filter(Boolean)
        .slice(0, 4)
    : [];

  return {
    total_amount: toNumber(source.total_amount),
    net_amount: toNumber(source.net_amount),
    vat_amount: toNumber(source.vat_amount),
    total_tax_amount: toNumber(source.total_tax_amount),
    printed_vat_rate_percent: toNumber(source.printed_vat_rate_percent),
    suggested_uk_tax_rate: normalizeFreeText(source.suggested_uk_tax_rate),
    total_evidence_text: normalizeFreeText(source.total_evidence_text),
    vat_evidence_text: normalizeFreeText(source.vat_evidence_text),
    vat_rate_evidence_text: normalizeFreeText(source.vat_rate_evidence_text),
    raw_text_summary: normalizeFreeText(source.raw_text_summary),
    tax_breakdown: Array.isArray(source.tax_breakdown)
      ? source.tax_breakdown
          .slice(0, 4)
          .map((item) =>
            typeof item === 'object' && item
              ? {
                  label: normalizeFreeText((item as Record<string, unknown>).label),
                  rate: toNumber((item as Record<string, unknown>).rate),
                  amount: toNumber((item as Record<string, unknown>).amount),
                }
              : null,
          )
          .filter(Boolean)
      : [],
    notes,
  };
}

function shouldRetryVatExtraction(raw: unknown) {
  if (typeof raw !== 'object' || !raw) {
    return false;
  }

  const source = raw as Record<string, unknown>;
  const totalAmount = toNumber(source.total_amount);
  const explicitVatAmount = toNumber(source.vat_amount);
  const printedVatRatePercent = toNumber(source.printed_vat_rate_percent);
  const rawTextSummary = normalizeFreeText(source.raw_text_summary);
  const notes = Array.isArray(source.notes)
    ? source.notes.map((note) => normalizeFreeText(note)).filter((note): note is string => Boolean(note))
    : [];
  const visibleText = [rawTextSummary, ...notes].join(' ');
  const isUnreadable = /could not read receipt|could not read invoice|blank image|no receipt visible/i.test(visibleText);

  if (isUnreadable || totalAmount === null) {
    return false;
  }

  return explicitVatAmount === null;
}

function mergeExtractionPayloads(baseRaw: unknown, vatRaw: unknown) {
  const base =
    typeof baseRaw === 'object' && baseRaw
      ? ({ ...(baseRaw as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  const vat =
    typeof vatRaw === 'object' && vatRaw ? (vatRaw as Record<string, unknown>) : {};

  const mergedNotes = [
    ...(Array.isArray(base.notes) ? base.notes : []),
    ...(Array.isArray(vat.notes) ? vat.notes : []),
  ];

  for (const key of [
    'net_amount',
    'vat_amount',
    'vat_evidence_text',
    'printed_vat_rate_percent',
    'vat_rate_evidence_text',
    'subtotal_amount',
    'total_tax_amount',
    'tax_breakdown',
  ]) {
    const incoming = vat[key];
    if (incoming !== undefined && incoming !== null && !(Array.isArray(incoming) && incoming.length === 0)) {
      base[key] = incoming;
    }
  }

  if (vat.raw_text_summary !== undefined && vat.raw_text_summary !== null) {
    base.raw_text_summary = vat.raw_text_summary;
  }

  if (mergedNotes.length) {
    base.notes = [...new Set(mergedNotes)];
  }

  return base;
}

function normalizeExtractionPayload(raw: unknown, requestedDocumentType: DocumentType): NormalizedExpenseDocument {
  const source = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
  const lineItems = Array.isArray(source.line_items) ? source.line_items : [];
  const taxBreakdown = Array.isArray(source.tax_breakdown) ? source.tax_breakdown : [];
  const confidenceScore = clampConfidence(toNumber(source.confidence_score));
  const normalizedDocumentType = parseDocumentType(
    typeof source.document_type === 'string' ? source.document_type : requestedDocumentType,
  );
  const vendorName = normalizeVendorName(source.vendor_name);
  const currency = normalizeCurrencyValue(source.currency, source.raw_text_summary);
  const extractedTotalAmount = toNumber(source.total_amount);
  const explicitVatAmount = toNumber(source.vat_amount);
  const explicitNetAmount = toNumber(source.net_amount);
  const notes = Array.isArray(source.notes)
    ? source.notes.map((note) => normalizeFreeText(note)).filter((note): note is string => Boolean(note))
    : [];
  const rawTextSummary = normalizeFreeText(source.raw_text_summary) || null;
  const totalEvidenceText = normalizeFreeText(source.total_evidence_text) || null;
  const vatEvidenceText = normalizeFreeText(source.vat_evidence_text) || null;
  const vatRateEvidenceText = normalizeFreeText(source.vat_rate_evidence_text) || null;
  const extractedPrintedVatRatePercent = resolvePrintedVatRatePercent(source, notes, rawTextSummary);
  const invoiceDate = normalizeDateString(source.invoice_date);
  const dueDate = normalizeDateString(source.due_date);
  const invoiceNumber = normalizeInvoiceNumber(source.invoice_number);
  const amountLooksUnreadable =
    notes.some((note) => /could not read receipt|could not read invoice|could not read amount|amount could not be read|unable to read amount|unable to read receipt|unable to read invoice|not clearly visible|blank image|blank file|no receipt visible|no invoice visible/i.test(note)) ||
    (rawTextSummary !== null &&
      /could not read receipt|could not read invoice|could not read amount|amount could not be read|not clearly visible|unable to read amount|unable to read receipt|unable to read invoice|blank image|blank file|no receipt visible|no invoice visible/i.test(rawTextSummary));
  const lacksStructuredEvidence =
    vendorName === null &&
    invoiceDate === null &&
    dueDate === null &&
    invoiceNumber === null &&
    lineItems.length === 0 &&
    taxBreakdown.length === 0;
  const totalAmountLooksUnreliable = totalLooksUnreliable({
    totalAmount: extractedTotalAmount,
    totalEvidenceText,
    confidenceScore,
    vendorName,
    invoiceDate,
    dueDate,
    invoiceNumber,
    lineItemCount: lineItems.length,
    taxBreakdownCount: taxBreakdown.length,
    amountLooksUnreadable,
  });
  const totalAmount = totalAmountLooksUnreliable ? null : extractedTotalAmount;
  const validatedNotes = totalAmountLooksUnreliable
    ? dedupeNotes([
        'Final total was not clearly visible, so the amount was cleared for manual review.',
        ...notes,
      ])
    : notes;
  const vatAmountLooksUnreliable = vatLooksUnreliable({
    explicitVatAmount,
    vatEvidenceText,
    printedVatRatePercent: extractedPrintedVatRatePercent,
    vatRateEvidenceText,
    confidenceScore,
    amountLooksUnreadable,
  });
  const validatedExplicitVatAmount = vatAmountLooksUnreliable ? null : explicitVatAmount;
  const printedVatRateLooksUnreliable = vatRateLooksUnreliable({
    printedVatRatePercent: extractedPrintedVatRatePercent,
    vatRateEvidenceText,
    confidenceScore,
    amountLooksUnreadable,
  });
  const printedVatRatePercent = printedVatRateLooksUnreliable ? null : extractedPrintedVatRatePercent;
  const taxRateApplied = resolveTaxRateApplied({
    suggestedTaxRate: source.suggested_uk_tax_rate ?? source.tax_rate_applied,
    printedVatRatePercent,
    totalAmount,
    explicitNetAmount,
    explicitVatAmount: validatedExplicitVatAmount,
    vatEvidenceText,
    vatRateEvidenceText,
  });
  const notesWithVatValidation =
    vatAmountLooksUnreliable || printedVatRateLooksUnreliable
      ? dedupeNotes([
          ...(vatAmountLooksUnreliable
            ? ['VAT amount was not clearly visible, so it was cleared for manual review.']
            : []),
          ...(printedVatRateLooksUnreliable
            ? ['VAT rate was not clearly visible, so it was cleared for manual review.']
            : []),
          ...validatedNotes,
        ])
      : validatedNotes;
  const documentLooksUnreadable =
    amountLooksUnreadable ||
    (lacksStructuredEvidence && extractedTotalAmount !== null && confidenceScore !== null && confidenceScore < 0.55) ||
    (totalAmount === null &&
      explicitVatAmount === null &&
      explicitNetAmount === null &&
      vendorName === null &&
      !rawTextSummary);
  const resolvedVatAmount = resolveVatAmount({
    totalAmount,
    explicitVatAmount: validatedExplicitVatAmount,
    explicitNetAmount,
    printedVatRatePercent,
    taxRateApplied,
  });
  const computedTotalTaxAmount = resolvedVatAmount ?? toNumber(source.total_tax_amount);
  const resolvedNetAmount = resolveNetAmount({
    totalAmount,
    explicitNetAmount,
    vatAmount: computedTotalTaxAmount,
    printedVatRatePercent,
    taxRateApplied,
  });
  const totalTaxAmount = computedTotalTaxAmount;
  const subtotalAmount = toNumber(source.subtotal_amount) ?? resolvedNetAmount;

  if (documentLooksUnreadable) {
    const unreadableNote = 'Could not read receipt or invoice.';
    return {
      vendorName: null,
      invoiceDate,
      dueDate,
      invoiceNumber,
      currency,
      totalAmount: 0,
      netAmount: 0,
      vatAmount: 0,
      taxRateApplied: 'No VAT',
      subtotalAmount: 0,
      totalTaxAmount: 0,
      documentType: normalizedDocumentType,
      confidenceScore,
      confidenceSource: confidenceScore === null ? 'unavailable' : 'model_self_assessment',
      needsReview: true,
      lineItems: [],
      taxBreakdown: [],
      notes: dedupeNotes([unreadableNote, ...notesWithVatValidation]),
      rawTextSummary: unreadableNote,
    };
  }

  return {
    vendorName,
    invoiceDate,
    dueDate,
    invoiceNumber,
    currency,
    totalAmount,
    netAmount: resolvedNetAmount,
    vatAmount: totalTaxAmount,
    taxRateApplied,
    subtotalAmount,
    totalTaxAmount,
    documentType: normalizedDocumentType,
    confidenceScore,
    confidenceSource: confidenceScore === null ? 'unavailable' : 'model_self_assessment',
    needsReview:
      confidenceScore === null ||
      confidenceScore < 0.7 ||
      totalAmount === null ||
      vendorName === null,
    lineItems: lineItems.map((item) => normalizeLineItem(item)).filter(Boolean) as NormalizedExpenseDocument['lineItems'],
    taxBreakdown: taxBreakdown
      .map((item) => normalizeTaxLine(item))
      .filter(Boolean) as NormalizedExpenseDocument['taxBreakdown'],
    notes: notesWithVatValidation,
    rawTextSummary,
  };
}

function normalizeLineItem(item: unknown) {
  if (typeof item !== 'object' || !item) {
    return null;
  }

  const source = item as Record<string, unknown>;
  return {
    description: sanitizeText(source.description) || 'Line item',
    quantity: toNumber(source.quantity),
    unitPrice: toNumber(source.unit_price),
    total: toNumber(source.total),
    taxAmount: toNumber(source.tax_amount),
  };
}

function normalizeTaxLine(item: unknown) {
  if (typeof item !== 'object' || !item) {
    return null;
  }

  const source = item as Record<string, unknown>;
  return {
    label: sanitizeText(source.label) || 'Tax',
    rate: toNumber(source.rate),
    amount: toNumber(source.amount),
  };
}

export function applyVatRegistrationRules(
  document: NormalizedExpenseDocument,
  taxProfile: { isVatRegistered: boolean; defaultTaxRateCosts?: string | null },
): NormalizedExpenseDocument {
  if (!taxProfile.isVatRegistered) {
    return {
      ...document,
      netAmount: document.totalAmount,
      vatAmount: 0,
      taxRateApplied: 'No VAT',
      subtotalAmount: document.totalAmount,
      totalTaxAmount: 0,
      taxBreakdown: [],
      notes: [...document.notes, 'VAT set to No VAT because the organisation is not VAT registered.'],
    };
  }

  const vatAmount = document.vatAmount ?? document.totalTaxAmount;
  const netAmount =
    document.netAmount ??
    (document.totalAmount !== null && vatAmount !== null ? roundMoney(document.totalAmount - vatAmount) : null);

  return {
    ...document,
    netAmount,
    vatAmount,
    taxRateApplied: document.taxRateApplied ?? normalizeUkTaxRate(taxProfile.defaultTaxRateCosts),
    subtotalAmount: document.subtotalAmount ?? netAmount,
    totalTaxAmount: document.totalTaxAmount ?? vatAmount,
  };
}

function normalizeUkTaxRate(value: unknown) {
  const text = sanitizeText(value).toLowerCase();
  if (!text) {
    return null;
  }
  if (text.includes('no vat')) {
    return 'No VAT';
  }
  if (text.includes('20') || text.includes('standard')) {
    return '20% Standard';
  }
  if (text.includes('5') || text.includes('reduced')) {
    return '5% Reduced';
  }
  if (text.includes('0') || text.includes('zero')) {
    return '0% Zero';
  }
  if (text.includes('exempt')) {
    return 'Exempt';
  }
  return null;
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function resolveVatAmount(input: {
  totalAmount: number | null;
  explicitVatAmount: number | null;
  explicitNetAmount: number | null;
  printedVatRatePercent: number | null;
  taxRateApplied: string | null;
}) {
  if (input.explicitVatAmount !== null) {
    return input.explicitVatAmount;
  }

  if (input.totalAmount !== null && input.explicitNetAmount !== null) {
    return roundMoney(Math.max(0, input.totalAmount - input.explicitNetAmount));
  }

  const effectiveRate = input.printedVatRatePercent ?? ukTaxRateToPercent(input.taxRateApplied);
  if (input.printedVatRatePercent !== null && input.totalAmount !== null && effectiveRate !== null && effectiveRate > 0) {
    return roundMoney(input.totalAmount * (effectiveRate / (100 + effectiveRate)));
  }

  if (effectiveRate === 0 && input.totalAmount !== null) {
    return 0;
  }

  return null;
}

function resolveNetAmount(input: {
  totalAmount: number | null;
  explicitNetAmount: number | null;
  vatAmount: number | null;
  printedVatRatePercent: number | null;
  taxRateApplied: string | null;
}) {
  if (input.explicitNetAmount !== null) {
    return input.explicitNetAmount;
  }
  if (input.totalAmount !== null && input.vatAmount !== null) {
    return roundMoney(input.totalAmount - input.vatAmount);
  }
  const effectiveRate = input.printedVatRatePercent ?? ukTaxRateToPercent(input.taxRateApplied);
  if (effectiveRate === 0 && input.totalAmount !== null) {
    return input.totalAmount;
  }
  return null;
}

function resolvePrintedVatRatePercent(
  source: Record<string, unknown>,
  notes: string[],
  rawTextSummary: string | null,
) {
  const explicitValue = toNumber(source.printed_vat_rate_percent);
  if (explicitValue !== null) {
    return explicitValue;
  }

  const taxBreakdown = Array.isArray(source.tax_breakdown) ? source.tax_breakdown : [];
  for (const item of taxBreakdown) {
    if (typeof item !== 'object' || !item) {
      continue;
    }
    const rate = toNumber((item as Record<string, unknown>).rate);
    if (rate !== null) {
      return rate;
    }
    const label = normalizeFreeText((item as Record<string, unknown>).label);
    const parsedRate = findPercentInText(label);
    if (parsedRate !== null) {
      return parsedRate;
    }
  }

  for (const text of [...notes, rawTextSummary ?? '']) {
    const parsedRate = findPercentInText(text);
    if (parsedRate !== null && /vat|tax/i.test(text)) {
      return parsedRate;
    }
  }

  return null;
}

function findPercentInText(value: string) {
  const match = value.match(/(\d+(?:\.\d+)?)\s*%/);
  return match ? Number(match[1]) : null;
}

function ukTaxRateToPercent(value: string | null) {
  if (!value) {
    return null;
  }
  if (value.startsWith('20%')) {
    return 20;
  }
  if (value.startsWith('5%')) {
    return 5;
  }
  if (value.startsWith('0%') || value === 'Exempt' || value === 'No VAT') {
    return 0;
  }
  return null;
}

function resolveTaxRateApplied(input: {
  suggestedTaxRate: unknown;
  printedVatRatePercent: number | null;
  totalAmount: number | null;
  explicitNetAmount: number | null;
  explicitVatAmount: number | null;
  vatEvidenceText: string | null;
  vatRateEvidenceText: string | null;
}) {
  if (input.printedVatRatePercent !== null) {
    return percentToUkTaxRate(input.printedVatRatePercent);
  }

  if (input.explicitVatAmount !== null && input.totalAmount !== null && input.explicitNetAmount !== null) {
    return percentToUkTaxRate(deriveVatRatePercent(input.explicitNetAmount, input.explicitVatAmount));
  }

  const normalizedSuggested = normalizeUkTaxRate(input.suggestedTaxRate);
  if (!normalizedSuggested) {
    return null;
  }

  const hasVatEvidence =
    (input.vatEvidenceText !== null && /\b(vat|tax)\b/i.test(input.vatEvidenceText) && /\d/.test(input.vatEvidenceText)) ||
    (input.vatRateEvidenceText !== null &&
      /\b(vat|tax)\b/i.test(input.vatRateEvidenceText) &&
      /(\d+(?:\.\d+)?)\s*%/.test(input.vatRateEvidenceText));

  return hasVatEvidence ? normalizedSuggested : null;
}

function deriveVatRatePercent(netAmount: number, vatAmount: number) {
  if (netAmount <= 0 || vatAmount < 0) {
    return null;
  }

  const rate = (vatAmount / netAmount) * 100;
  if (Math.abs(rate - 20) < 0.75) {
    return 20;
  }
  if (Math.abs(rate - 5) < 0.75) {
    return 5;
  }
  if (Math.abs(rate) < 0.25) {
    return 0;
  }
  return null;
}

function percentToUkTaxRate(percent: number | null) {
  if (percent === null) {
    return null;
  }
  if (Math.abs(percent - 20) < 0.75) {
    return '20% Standard';
  }
  if (Math.abs(percent - 5) < 0.75) {
    return '5% Reduced';
  }
  if (Math.abs(percent) < 0.25) {
    return '0% Zero';
  }
  return null;
}

function totalLooksUnreliable(input: {
  totalAmount: number | null;
  totalEvidenceText: string | null;
  confidenceScore: number | null;
  vendorName: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  lineItemCount: number;
  taxBreakdownCount: number;
  amountLooksUnreadable: boolean;
}) {
  if (input.totalAmount === null) {
    return false;
  }

  if (input.amountLooksUnreadable) {
    return true;
  }

  const totalEvidenceHasLabel =
    input.totalEvidenceText !== null &&
    /\b(total|amount due|balance due|grand total|card payment|paid|to pay)\b/i.test(input.totalEvidenceText);
  const totalEvidenceHasNumber =
    input.totalEvidenceText !== null && /\d/.test(input.totalEvidenceText);

  if (!totalEvidenceHasLabel || !totalEvidenceHasNumber) {
    return true;
  }

  const lacksDocumentIdentity =
    input.vendorName === null &&
    input.invoiceDate === null &&
    input.dueDate === null &&
    input.invoiceNumber === null &&
    input.lineItemCount === 0 &&
    input.taxBreakdownCount === 0;

  if (input.confidenceScore !== null && input.confidenceScore < 0.5) {
    return true;
  }

  if (lacksDocumentIdentity && input.confidenceScore !== null && input.confidenceScore < 0.85) {
    return true;
  }

  return false;
}

function vatLooksUnreliable(input: {
  explicitVatAmount: number | null;
  vatEvidenceText: string | null;
  printedVatRatePercent: number | null;
  vatRateEvidenceText: string | null;
  confidenceScore: number | null;
  amountLooksUnreadable: boolean;
}) {
  if (input.explicitVatAmount === null) {
    return false;
  }

  if (input.amountLooksUnreadable) {
    return true;
  }

  const vatEvidenceHasLabel =
    input.vatEvidenceText !== null && /\b(vat|tax)\b/i.test(input.vatEvidenceText);
  const vatEvidenceHasNumber =
    input.vatEvidenceText !== null && /\d/.test(input.vatEvidenceText);

  if (!vatEvidenceHasLabel || !vatEvidenceHasNumber) {
    return true;
  }

  if (input.confidenceScore !== null && input.confidenceScore < 0.5) {
    return true;
  }

  if (
    input.printedVatRatePercent !== null &&
    input.vatRateEvidenceText !== null &&
    !/\b(vat|tax)\b/i.test(input.vatRateEvidenceText)
  ) {
    return true;
  }

  return false;
}

function vatRateLooksUnreliable(input: {
  printedVatRatePercent: number | null;
  vatRateEvidenceText: string | null;
  confidenceScore: number | null;
  amountLooksUnreadable: boolean;
}) {
  if (input.printedVatRatePercent === null) {
    return false;
  }

  if (input.amountLooksUnreadable) {
    return true;
  }

  const vatRateHasTaxLabel =
    input.vatRateEvidenceText !== null && /\b(vat|tax)\b/i.test(input.vatRateEvidenceText);
  const vatRateHasPercent =
    input.vatRateEvidenceText !== null && /(\d+(?:\.\d+)?)\s*%/.test(input.vatRateEvidenceText);

  if (!vatRateHasTaxLabel || !vatRateHasPercent) {
    return true;
  }

  if (input.confidenceScore !== null && input.confidenceScore < 0.5) {
    return true;
  }

  return false;
}

function dedupeNotes(notes: string[]) {
  return [...new Set(notes.filter(Boolean))];
}

function normalizeFreeText(value: unknown) {
  const text = sanitizeText(value);
  if (!text) {
    return '';
  }

  return text
    .replace(/Â£/g, '£')
    .replace(/Â€/g, '€')
    .replace(/Â\$/g, '$')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeVendorName(value: unknown) {
  const text = normalizeFreeText(value);
  if (!text) {
    return null;
  }

  const lowered = text.toLowerCase();
  if (
    lowered.includes('workspace') ||
    lowered.includes('uploaded document') ||
    lowered.includes('exdox')
  ) {
    return null;
  }

  return text;
}

function normalizeInvoiceNumber(value: unknown) {
  const text = normalizeFreeText(value);
  if (!text) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return null;
  }

  return text;
}

function normalizeCurrencyValue(currency: unknown, summary: unknown) {
  const normalized = normalizeCurrencyCode(currency);
  if (normalized) {
    return normalized;
  }

  const summaryText = normalizeFreeText(summary);
  if (summaryText.includes('£')) {
    return 'GBP';
  }
  if (summaryText.includes('€')) {
    return 'EUR';
  }
  if (summaryText.includes('$')) {
    return 'USD';
  }

  return null;
}
