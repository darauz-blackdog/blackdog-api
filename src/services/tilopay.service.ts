import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SAFETY_MARGIN_MS = 5 * 60 * 1000;   // 5 min

let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Tilopay API service — mirrors the Odoo tilopay_api_service.py logic
 * Endpoints:
 *   POST /api/v1/login          → get JWT access token
 *   POST /api/v1/processPayment → create payment link
 *   POST /api/v1/consult        → check payment status by orderNumber
 */

function buildUrl(path: string): string {
  const base = env.TILOPAY_API_BASE_URL.replace(/\/$/, '');
  return `${base}${path.startsWith('/') ? path : '/' + path}`;
}

async function getAccessToken(): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const { TILOPAY_API_USER, TILOPAY_API_PASSWORD } = env;
  if (!TILOPAY_API_USER || !TILOPAY_API_PASSWORD) {
    throw new Error('Tilopay API credentials not configured');
  }

  const url = buildUrl('/api/v1/login');
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiuser: TILOPAY_API_USER, password: TILOPAY_API_PASSWORD }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text }, 'Tilopay login failed');
    throw new Error(`Tilopay login failed (${res.status})`);
  }

  const data = await res.json();
  const token = data.access_token;
  if (!token) {
    throw new Error('No access_token in Tilopay login response');
  }

  cachedToken = token;
  tokenExpiry = Date.now() + TOKEN_TTL_MS - SAFETY_MARGIN_MS;
  logger.info('Tilopay token obtained and cached');
  return token;
}

function invalidateToken() {
  cachedToken = null;
  tokenExpiry = 0;
}

async function makeRequest<T = any>(
  method: string,
  path: string,
  payload?: Record<string, unknown>,
  retry = false,
): Promise<T> {
  const token = await getAccessToken();
  const url = buildUrl(path);

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `bearer ${token}`,
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  // Retry once on 401 (expired token)
  if (res.status === 401 && !retry) {
    logger.warn('Tilopay 401 — refreshing token and retrying');
    invalidateToken();
    return makeRequest(method, path, payload, true);
  }

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text, path }, 'Tilopay API error');
    throw new Error(`Tilopay API error (${res.status}): ${text}`);
  }

  return res.json() as Promise<T>;
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

interface CreatePaymentLinkParams {
  orderNumber: string;
  amount: number;
  currency?: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
}

interface PaymentLinkResult {
  payment_link: string;
  tilopay_transaction_id: string;
}

/**
 * Create a Tilopay payment link using /api/v1/processPayment.
 * The customer opens this link in a browser/WebView to pay.
 * After payment, Tilopay redirects to TILOPAY_REDIRECT_URL with query params.
 */
export async function createPaymentLink(params: CreatePaymentLinkParams): Promise<PaymentLinkResult> {
  const { TILOPAY_API_KEY, TILOPAY_REDIRECT_URL } = env;
  if (!TILOPAY_API_KEY) {
    throw new Error('Tilopay API key not configured');
  }

  const nameParts = params.customerName.split(' ');
  const firstName = nameParts[0] || 'Cliente';
  const lastName = nameParts.slice(1).join(' ') || '';

  const payload: Record<string, unknown> = {
    redirect: TILOPAY_REDIRECT_URL || 'https://blackdogpanama.com',
    key: TILOPAY_API_KEY,
    amount: params.amount.toFixed(2),
    currency: params.currency ?? 'USD',
    orderNumber: params.orderNumber,
    capture: '1', // authorize + capture
    billToFirstName: firstName,
    billToLastName: lastName,
    billToAddress: '',
    billToAddress2: '',
    billToCity: 'Panama',
    billToState: 'PA',
    billToZipPostCode: '',
    billToCountry: 'PA',
    billToTelephone: params.customerPhone ?? '',
    billToEmail: params.customerEmail,
    shipToFirstName: firstName,
    shipToLastName: lastName,
    shipToAddress: '',
    shipToAddress2: '',
    shipToCity: 'Panama',
    shipToState: 'PA',
    shipToZipPostCode: '',
    shipToCountry: 'PA',
    shipToTelephone: params.customerPhone ?? '',
    subscription: '0',
    platform: 'blackdog-app',
    returnData: Buffer.from(params.orderNumber).toString('base64'),
    hashVersion: 'V2',
  };

  const response = await makeRequest<{
    type?: string;
    url?: string;
    message?: string;
  }>('POST', '/api/v1/processPayment', payload);

  // type "100" = success
  if (response.type === '100' && response.url) {
    logger.info({ orderNumber: params.orderNumber, link: response.url }, 'Tilopay payment link created');
    return {
      payment_link: response.url,
      tilopay_transaction_id: params.orderNumber, // temporary, updated on redirect callback
    };
  }

  throw new Error(`Tilopay processPayment failed: ${response.message ?? JSON.stringify(response)}`);
}

interface PaymentStatus {
  code: string; // "1" = approved
  description: string;
  id_tilopay?: string;
  date?: string;
  amount?: string;
}

/**
 * Check a payment status using /api/v1/consult
 */
export async function getPaymentStatus(orderNumber: string): Promise<PaymentStatus | null> {
  const { TILOPAY_API_KEY } = env;
  if (!TILOPAY_API_KEY) {
    throw new Error('Tilopay API key not configured');
  }

  const response = await makeRequest<{
    type?: string;
    response?: PaymentStatus[];
  }>('POST', '/api/v1/consult', {
    key: TILOPAY_API_KEY,
    orderNumber,
    merchantId: '',
  });

  // type "200" = query success
  if (response.type === '200' && response.response?.length) {
    return response.response[0];
  }

  return null;
}

/**
 * Get SDK token for Tilopay SDK V2 frontend integration.
 * Used by Tilopay.Init() in the HTML bridge page.
 */
export async function getSDKToken(): Promise<string> {
  const { TILOPAY_API_KEY } = env;
  if (!TILOPAY_API_KEY) throw new Error('Tilopay API key not configured');

  const response = await makeRequest<{ token?: string; type?: string; message?: string }>(
    'POST', '/api/v1/tokenize', { key: TILOPAY_API_KEY }
  );

  if (response.token) return response.token;
  throw new Error(`Tilopay SDK token failed: ${response.message ?? JSON.stringify(response)}`);
}
