import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import { requireAdminUser, requireAuthenticatedUser } from '../shared/auth.js';
import { createReceiptDownloadUrl } from '../shared/s3.js';
import { jsonResponse } from '../shared/http.js';
import {
  addSalesPayment,
  convertQuoteToInvoice,
  deleteSalesCustomer,
  getSalesDocumentPdf,
  getSalesWorkspace,
  importSalesCustomers,
  issueSalesDocument,
  rotateSubmissionAddress,
  saveSalesCustomer,
  saveSalesDocument,
} from '../shared/salesWorkspaceStore.js';

export async function listHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    const action = event.queryStringParameters?.action ?? '';
    const id = event.queryStringParameters?.id ?? '';

    if (action === 'document_pdf') {
      const { document, pdfKey } = await getSalesDocumentPdf(user, id);
      const asset = await createReceiptDownloadUrl({ key: pdfKey, fileName: `${document.number}.pdf`, disposition: 'inline' });
      return jsonResponse(200, { success: true, document, previewUrl: asset.downloadUrl, downloadUrl: asset.downloadUrl });
    }
    return jsonResponse(200, { success: true, ...(await getSalesWorkspace(user)) });
  } catch (error) { return salesWorkspaceError(error); }
}

export async function actionHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    const body = event.body ? JSON.parse(event.body) as Record<string, unknown> : {};
    const action = String(body.action ?? '');
    if (action === 'customer') return jsonResponse(200, { success: true, customer: await saveSalesCustomer(user, body) });
    if (action === 'import_customers') return jsonResponse(200, { success: true, customers: await importSalesCustomers(user, Array.isArray(body.rows) ? body.rows : []) });
    if (action === 'document') return jsonResponse(200, { success: true, document: await saveSalesDocument(user, body) });
    if (action === 'payment') return jsonResponse(200, { success: true, document: await addSalesPayment(user, String(body.documentId ?? ''), body) });
    if (action === 'convert_quote') return jsonResponse(200, { success: true, ...(await convertQuoteToInvoice(user, String(body.documentId ?? ''))) });
    if (action === 'issue_document') return jsonResponse(200, { success: true, ...(await issueSalesDocument(user, String(body.documentId ?? ''))) });
    if (action === 'rotate_address') return jsonResponse(200, { success: true, submissionAddress: await rotateSubmissionAddress(user) });
    return jsonResponse(400, { success: false, error: 'unsupported_sales_action', message: 'Choose a supported Sales workspace action.' });
  } catch (error) { return salesWorkspaceError(error); }
}

export async function deleteHandler(event: APIGatewayProxyEventV2) {
  try {
    const user = requireAuthenticatedUser(event);
    requireAdminUser(user);
    if (event.queryStringParameters?.action !== 'customer') return jsonResponse(400, { success: false, error: 'unsupported_sales_action', message: 'Choose a supported Sales workspace action.' });
    await deleteSalesCustomer(user, event.queryStringParameters?.id ?? '');
    return jsonResponse(200, { success: true });
  } catch (error) { return salesWorkspaceError(error); }
}

function salesWorkspaceError(error: unknown) {
  const status = typeof error === 'object' && error !== null && 'statusCode' in error ? Number((error as { statusCode?: number }).statusCode) : 500;
  return jsonResponse(status, {
    success: false,
    error: typeof error === 'object' && error !== null && 'code' in error ? String((error as { code?: string }).code) : 'sales_workspace_failed',
    message: error instanceof Error ? error.message : 'Could not update the Sales workspace.',
  });
}
