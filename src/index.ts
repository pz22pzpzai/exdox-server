import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import cors from 'cors';
import dotenv from 'dotenv';
import express, { type Request, type Response } from 'express';
import multer from 'multer';
import OpenAI from 'openai';

dotenv.config();

type DocumentType = 'receipt' | 'invoice' | 'unknown';

type ExpenseRequestOptions = {
  locale: string;
  extractLineItems: boolean;
  documentType: DocumentType;
};

type NormalizedExpenseDocument = {
  vendorName: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceNumber: string | null;
  currency: string | null;
  totalAmount: number | null;
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

type ExtractionEnvelope = {
  success: true;
  provider: {
    name: 'openai';
    model: string;
  };
  options: ExpenseRequestOptions;
  document: NormalizedExpenseDocument;
};

const port = Number(process.env.PORT ?? 8787);
const maxUploadMb = Number(process.env.MAX_UPLOAD_MB ?? 25);
const requestTimeoutMs = Number(process.env.EXPENSES_REQUEST_TIMEOUT_MS ?? 45000);
const model = process.env.OPENAI_MODEL ?? 'gpt-4.1-nano';

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for the expenses proxy.');
}

const app = express();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxUploadMb * 1024 * 1024,
  },
});
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: requestTimeoutMs,
});

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'exdox-expenses-api',
    model,
    now: new Date().toISOString(),
  });
});

app.post('/api/v1/expenses/process', upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) {
    res.status(400).json({
      success: false,
      error: 'missing_file',
      message: 'Upload a receipt image or invoice PDF in the `file` field.',
    });
    return;
  }

  const options = readRequestOptions(req);
  console.log('Expense extraction request received', {
    fileName: file.originalname,
    mimeType: file.mimetype,
    size: file.size,
    locale: options.locale,
    documentType: options.documentType,
    extractLineItems: options.extractLineItems,
    model,
    receivedAt: new Date().toISOString(),
  });

  try {
    const document = await processExpenseDocument(file, options);
    const payload: ExtractionEnvelope = {
      success: true,
      provider: {
        name: 'openai',
        model,
      },
      options,
      document,
    };

    if (document.confidenceScore !== null && document.confidenceScore < 0.7) {
      console.warn('Low-confidence expense extraction', {
        fileName: file.originalname,
        confidenceScore: document.confidenceScore,
      });
    }

    console.log('Expense extraction completed', {
      fileName: file.originalname,
      vendorName: document.vendorName,
      totalAmount: document.totalAmount,
      currency: document.currency,
      extractionStatus: document.totalAmount === null ? 'unreadable_total' : 'amount_found',
      completedAt: new Date().toISOString(),
    });

    res.json(payload);
  } catch (error) {
    const normalized = normalizeError(error);
    console.error('Expense extraction failed', {
      fileName: file.originalname,
      code: normalized.code,
      message: normalized.message,
      failedAt: new Date().toISOString(),
    });
    res.status(normalized.status).json({
      success: false,
      error: normalized.code,
      message: normalized.message,
    });
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  const normalized = normalizeError(error);
  res.status(normalized.status).json({
    success: false,
    error: normalized.code,
    message: normalized.message,
  });
});

app.listen(port, () => {
  console.log(`exdox expenses proxy listening on port ${port}`);
});

function readRequestOptions(req: Request): ExpenseRequestOptions {
  const input = {
    ...req.query,
    ...req.body,
  } as Record<string, string | undefined>;

  return {
    locale: sanitizeText(input.locale) || 'en-GB',
    extractLineItems: parseBoolean(input.extract_line_items, true),
    documentType: parseDocumentType(input.document_type),
  };
}

async function processExpenseDocument(
  file: Express.Multer.File,
  options: ExpenseRequestOptions,
): Promise<NormalizedExpenseDocument> {
  const responseText = await extractWithOpenAI(file, options);
  return normalizeExtractionPayload(parseExtractionJson(responseText), options.documentType);
}

async function extractWithOpenAI(
  file: Express.Multer.File,
  options: ExpenseRequestOptions,
): Promise<string> {
  const inputContent: Array<Record<string, unknown>> = [
    {
      type: 'input_text',
      text: buildExtractionPrompt(options),
    },
  ];

  const mimeType = file.mimetype || inferMimeType(file.originalname);
  if (mimeType === 'application/pdf') {
    const tempPath = path.join(os.tmpdir(), `${Date.now()}-${sanitizeFileName(file.originalname)}`);
    await fs.promises.writeFile(tempPath, file.buffer);

    try {
      const uploadedFile = await openai.files.create({
        file: fs.createReadStream(tempPath),
        purpose: 'user_data',
      });

      inputContent.push({
        type: 'input_file',
        file_id: uploadedFile.id,
      });
    } finally {
      await fs.promises.rm(tempPath, { force: true });
    }
  } else {
    inputContent.push({
      type: 'input_image',
      image_url: `data:${mimeType};base64,${file.buffer.toString('base64')}`,
      detail: 'high',
    });
  }

  const response = await openai.responses.create({
    model,
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

function buildExtractionPrompt(options: ExpenseRequestOptions): string {
  return [
    'Read this receipt or invoice and return valid JSON only.',
    'Do not wrap the JSON in markdown fences.',
    'This is an OCR-style extraction task. Prefer literal reading over inference.',
    'Do not guess missing values.',
    'If the total amount is not clearly visible or cannot be read confidently, return total_amount as null.',
    'If tax is not clearly visible, return total_tax_amount as null.',
    'If subtotal is not clearly visible, return subtotal_amount as null.',
    'Use the printed currency symbol/code on the document when visible. Otherwise return null.',
    'For receipts, prioritize the final charged amount actually paid.',
    'For invoices, prioritize the invoice total due.',
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

function normalizeExtractionPayload(raw: unknown, requestedDocumentType: DocumentType): NormalizedExpenseDocument {
  const source = typeof raw === 'object' && raw ? (raw as Record<string, unknown>) : {};
  const lineItems = Array.isArray(source.line_items) ? source.line_items : [];
  const taxBreakdown = Array.isArray(source.tax_breakdown) ? source.tax_breakdown : [];
  const confidenceScore = clampConfidence(toNumber(source.confidence_score));
  const normalizedDocumentType = parseDocumentType(
    typeof source.document_type === 'string' ? source.document_type : requestedDocumentType,
  );

  return {
    vendorName: sanitizeText(source.vendor_name) || null,
    invoiceDate: normalizeDateString(source.invoice_date),
    dueDate: normalizeDateString(source.due_date),
    invoiceNumber: sanitizeText(source.invoice_number) || null,
    currency: normalizeCurrencyCode(source.currency),
    totalAmount: toNumber(source.total_amount),
    subtotalAmount: toNumber(source.subtotal_amount),
    totalTaxAmount: toNumber(source.total_tax_amount),
    documentType: normalizedDocumentType,
    confidenceScore,
    confidenceSource: confidenceScore === null ? 'unavailable' : 'model_self_assessment',
    needsReview: confidenceScore === null || confidenceScore < 0.7,
    lineItems: lineItems.map((item) => normalizeLineItem(item)).filter(Boolean) as NormalizedExpenseDocument['lineItems'],
    taxBreakdown: taxBreakdown
      .map((item) => normalizeTaxLine(item))
      .filter(Boolean) as NormalizedExpenseDocument['taxBreakdown'],
    notes: Array.isArray(source.notes)
      ? source.notes.map((note) => sanitizeText(note)).filter((note): note is string => Boolean(note))
      : [],
    rawTextSummary: sanitizeText(source.raw_text_summary) || null,
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

function normalizeError(error: unknown) {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return {
      status: 413,
      code: 'file_too_large',
      message: `The uploaded file is too large. Keep uploads under ${maxUploadMb} MB.`,
    };
  }

  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return {
      status: 504,
      code: 'provider_timeout',
      message: 'The OCR provider timed out while processing the document. Try a smaller or clearer file.',
    };
  }

  if (error instanceof OpenAI.APIError) {
    return {
      status: 502,
      code: 'provider_error',
      message: error.message || 'The OCR provider could not process the document.',
    };
  }

  if (error instanceof Error) {
    return {
      status: 500,
      code: 'internal_error',
      message: error.message,
    };
  }

  return {
    status: 500,
    code: 'internal_error',
    message: 'Unexpected server error.',
  };
}

function sanitizeText(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseBoolean(value: unknown, fallback: boolean) {
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

function parseDocumentType(value: unknown): DocumentType {
  if (value === 'receipt' || value === 'invoice') {
    return value;
  }
  return 'unknown';
}

function toNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = Number(value.replace(/[^0-9.-]/g, ''));
    return Number.isFinite(normalized) ? normalized : null;
  }
  return null;
}

function clampConfidence(value: number | null) {
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

function normalizeDateString(value: unknown) {
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

function normalizeCurrencyCode(value: unknown) {
  const text = sanitizeText(value).toUpperCase();
  return /^[A-Z]{3}$/.test(text) ? text : null;
}

function inferMimeType(fileName: string) {
  const extension = path.extname(fileName).toLowerCase();
  if (extension === '.pdf') {
    return 'application/pdf';
  }
  if (extension === '.png') {
    return 'image/png';
  }
  if (extension === '.webp') {
    return 'image/webp';
  }
  return 'image/jpeg';
}
