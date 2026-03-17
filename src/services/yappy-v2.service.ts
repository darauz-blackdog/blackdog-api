import crypto from 'crypto';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const getConfig = () => ({
  merchantId: env.YAPPY_V2_MERCHANT_ID ?? '',
  secretKey: env.YAPPY_V2_SECRET_KEY ?? '',
  domain: env.YAPPY_V2_DOMAIN ?? '',
  ipnUrl: env.YAPPY_V2_IPN_URL ?? '',
  apiUrl: (env.YAPPY_V2_API_URL ?? 'https://apipagosbg.bgeneral.cloud').replace(/\/$/, ''),
});

export function isYappyV2Configured(): boolean {
  const c = getConfig();
  return !!(c.merchantId && c.secretKey && c.domain);
}

async function validateMerchant(): Promise<{ token: string; epochTime: number }> {
  const { merchantId, domain, apiUrl } = getConfig();
  const res = await fetch(`${apiUrl}/payments/validate/merchant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ merchantId, urlDomain: domain }),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text }, 'Yappy V2 validate merchant failed');
    throw new Error(`Yappy V2 validate merchant failed (${res.status})`);
  }
  const data = await res.json();
  if (!data.body?.token) throw new Error('Yappy V2 validate merchant: no token');
  return { token: data.body.token, epochTime: data.body.epochTime };
}

export interface CreateYappyOrderParams {
  orderId: string;
  phone: string;
  subtotal: number;
  taxes: number;
  discount: number;
  total: number;
}

export interface YappyOrderResult {
  transactionId: string;
  token: string;
  documentName: string;
}

export async function createYappyOrder(params: CreateYappyOrderParams): Promise<YappyOrderResult> {
  const { merchantId, domain, ipnUrl, apiUrl } = getConfig();
  const { token } = await validateMerchant();
  const yappyOrderId = params.orderId.slice(0, 15);

  const res = await fetch(`${apiUrl}/payments/payment-wc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({
      merchantId,
      orderId: yappyOrderId,
      domain,
      paymentDate: Math.floor(Date.now() / 1000),
      aliasYappy: params.phone.replace(/\D/g, ''),
      ipnUrl,
      discount: params.discount.toFixed(2),
      taxes: params.taxes.toFixed(2),
      subtotal: params.subtotal.toFixed(2),
      total: params.total.toFixed(2),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    logger.error({ status: res.status, body: text }, 'Yappy V2 create order failed');
    throw new Error(`Yappy V2 create order failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.body?.transactionId) {
    const errCode = data.status?.code ?? 'unknown';
    const errDesc = data.status?.description ?? JSON.stringify(data);
    throw new Error(`Yappy V2 order error (${errCode}): ${errDesc}`);
  }

  logger.info({ orderId: yappyOrderId, transactionId: data.body.transactionId }, 'Yappy V2 order created');
  return {
    transactionId: data.body.transactionId,
    token: data.body.token,
    documentName: data.body.documentName,
  };
}

export function verifyIPNHash(params: { orderId: string; status: string; domain: string; hash: string }): boolean {
  const { secretKey } = getConfig();
  if (!secretKey) return false;
  const message = `${params.orderId}${params.status}${params.domain}`;
  const expected = crypto.createHmac('sha256', secretKey).update(message).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(params.hash, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}
