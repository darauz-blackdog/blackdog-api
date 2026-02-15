import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Yappy API service — mirrors the Odoo yappy_api_service.py logic
 *
 * Yappy (by Banco General, Panama) uses a POS-style flow:
 *   1. Customer pays via their Yappy app to BlackDog's collection alias
 *   2. Backend polls /v1/movement/history to detect the matching payment
 *
 * Authentication:
 *   - Generate seed: HMAC-SHA256(api_key + YYYY-MM-DD, secret_key)
 *   - POST /v1/session/login → JWT token
 *
 * Endpoints:
 *   GET  /v1/collection-method       → list collection methods
 *   POST /v1/movement/history        → search transactions
 *   GET  /v1/movement/{id}           → transaction detail
 *   PUT  /v1/transaction/{id}        → refund
 */

function generateSeed(): string {
  const { YAPPY_API_KEY, YAPPY_SECRET_KEY } = env;
  if (!YAPPY_API_KEY || !YAPPY_SECRET_KEY) {
    throw new Error('Yappy credentials not configured');
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const message = `${YAPPY_API_KEY}${today}`;

  return crypto
    .createHmac('sha256', YAPPY_SECRET_KEY)
    .update(message)
    .digest('hex');
}

async function getAccessToken(): Promise<string> {
  const { YAPPY_API_KEY, YAPPY_SECRET_KEY, YAPPY_API_BASE_URL } = env;
  if (!YAPPY_API_KEY || !YAPPY_SECRET_KEY) {
    throw new Error('Yappy credentials not configured');
  }

  const url = `${YAPPY_API_BASE_URL}/v1/session/login`;
  const seed = generateSeed();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': YAPPY_API_KEY,
        'X-Secret-Key': YAPPY_SECRET_KEY,
      },
      body: JSON.stringify({ body: { code: seed } }),
      signal: controller.signal,
    });

    const data = await res.json() as any;

    if (data?.status?.code === 'YP-0000') {
      const token = data?.body?.token?.token;
      if (token) {
        logger.info('Yappy JWT token obtained');
        return token;
      }
    }

    logger.warn({ response: data }, 'Yappy login failed');
    throw new Error(`Yappy login failed: ${data?.status?.description ?? 'unknown error'}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function makeRequest<T = any>(
  method: string,
  path: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const token = await getAccessToken();
  const url = `${env.YAPPY_API_BASE_URL}${path}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    let res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: controller.signal,
    });

    // Retry on 401
    if (res.status === 401) {
      logger.info('Yappy token expired, re-authenticating...');
      const freshToken = await getAccessToken();
      res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${freshToken}`,
        },
        body: payload ? JSON.stringify(payload) : undefined,
      });
    }

    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

// ----------------------------------------------------------------
// Public API
// ----------------------------------------------------------------

interface YappyMovement {
  transactionId?: string;
  amount?: number;
  debitorName?: string;
  debitorAlias?: string;
  description?: string;
  date?: string;
  category?: string;
  type?: string;
}

interface YappyHistoryResponse {
  status?: { code?: string; description?: string };
  body?: {
    movements?: YappyMovement[];
  };
}

/**
 * Check if Yappy is configured and can authenticate
 */
export function isYappyConfigured(): boolean {
  return !!(env.YAPPY_API_KEY && env.YAPPY_SECRET_KEY && env.YAPPY_COLLECTION_ALIAS);
}

/**
 * Get collection methods configured in Yappy
 */
export async function getCollectionMethods(): Promise<any> {
  return makeRequest('GET', '/v1/collection-method');
}

/**
 * Search Yappy movement history for recent payments.
 * Used to match incoming payments to pending orders.
 *
 * @param startDate ISO date string (YYYY-MM-DD)
 * @param endDate ISO date string (YYYY-MM-DD)
 * @param limit max results
 */
export async function getMovementHistory(
  startDate: string,
  endDate: string,
  limit = 20,
): Promise<YappyMovement[]> {
  const collectionAlias = env.YAPPY_COLLECTION_ALIAS;

  const payload: Record<string, unknown> = {
    body: {
      pagination: {
        start_date: startDate,
        end_date: endDate,
        limit,
      },
      filter: [
        { id: 'COLLECTION_ALIAS', value: collectionAlias },
        { id: 'ROLE', value: 'CREDIT' },
      ],
    },
  };

  const response = await makeRequest<YappyHistoryResponse>('POST', '/v1/movement/history', payload);

  if (response?.status?.code === 'YP-0000') {
    return response?.body?.movements ?? [];
  }

  logger.warn({ response }, 'Yappy movement history query returned non-success');
  return [];
}

/**
 * Get transaction detail from Yappy
 */
export async function getMovementDetail(transactionId: string): Promise<any> {
  return makeRequest('GET', `/v1/movement/${transactionId}`);
}

/**
 * Try to match a Yappy payment to a pending order.
 * Looks for a CREDIT movement in the last 24h that matches the expected amount.
 *
 * @param expectedAmount the order total to match
 * @param referenceHint optional: the order reference the customer should include in description
 * @returns matched transaction or null
 */
export async function findMatchingPayment(
  expectedAmount: number,
  referenceHint?: string,
): Promise<YappyMovement | null> {
  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const startDate = yesterday.toISOString().slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const movements = await getMovementHistory(startDate, endDate, 50);

  // First pass: exact match on amount + reference in description
  if (referenceHint) {
    const refUpper = referenceHint.toUpperCase();
    const exactMatch = movements.find(
      (m) =>
        Math.abs((m.amount ?? 0) - expectedAmount) < 0.01 &&
        (m.description ?? '').toUpperCase().includes(refUpper),
    );
    if (exactMatch) return exactMatch;
  }

  // Second pass: match by amount only (within tolerance)
  // This is less reliable but catches payments without a reference
  const amountMatch = movements.find(
    (m) => Math.abs((m.amount ?? 0) - expectedAmount) < 0.01,
  );

  return amountMatch ?? null;
}

/**
 * Get Yappy payment instructions for the customer.
 * This is what the app displays so the customer knows how to pay.
 */
export function getPaymentInstructions(orderReference: string, amount: number) {
  return {
    method: 'yappy',
    collection_alias: env.YAPPY_COLLECTION_ALIAS || 'BlackDogPanama',
    amount,
    currency: 'USD',
    reference: orderReference,
    instructions: [
      'Abre la app de Yappy en tu celular',
      `Busca "${env.YAPPY_COLLECTION_ALIAS || 'BlackDog Panama'}" o escanea el QR`,
      `Envía exactamente $${amount.toFixed(2)}`,
      `En la descripción escribe: ${orderReference}`,
      'Tu pedido se confirmará automáticamente cuando detectemos el pago',
    ],
    note: 'El pago puede tardar hasta 3 minutos en ser detectado.',
  };
}
