import xmlrpc from 'xmlrpc';
import { env } from './env.js';
import { logger } from './logger.js';

const url = new URL(env.ODOO_URL);
const isSecure = url.protocol === 'https:';

const RPC_TIMEOUT = 30_000; // 30s per call
const MAX_RETRIES = 2;      // retry up to 2 times (3 attempts total)
const RETRY_DELAY = 1_000;  // 1s between retries

function createClient(path: string) {
  const options = {
    host: url.hostname,
    port: isSecure ? 443 : (parseInt(url.port) || 80),
    path,
  };
  return isSecure
    ? xmlrpc.createSecureClient(options)
    : xmlrpc.createClient(options);
}

const commonClient = createClient('/xmlrpc/2/common');
const objectClient = createClient('/xmlrpc/2/object');

let uid: number | null = null;

function callWithTimeout<T>(
  client: xmlrpc.Client,
  method: string,
  params: unknown[],
  timeout: number
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Odoo RPC timeout after ${timeout}ms`));
    }, timeout);

    client.methodCall(method, params, (error, value) => {
      clearTimeout(timer);
      if (error) return reject(error);
      resolve(value as T);
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/** Authenticate and get the user ID */
export async function authenticate(): Promise<number> {
  if (uid) return uid;

  const value = await callWithTimeout<number | false>(
    commonClient,
    'authenticate',
    [env.ODOO_DB, env.ODOO_USERNAME, env.ODOO_PASSWORD, {}],
    RPC_TIMEOUT
  );

  if (!value) {
    throw new Error('Odoo authentication returned false — check credentials');
  }

  uid = value;
  logger.info({ uid }, 'Authenticated with Odoo');
  return uid;
}

/** Execute a method on an Odoo model with retry */
export async function execute_kw<T = unknown>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const userId = await authenticate();
      const result = await callWithTimeout<T>(
        objectClient,
        'execute_kw',
        [env.ODOO_DB, userId, env.ODOO_PASSWORD, model, method, args, kwargs],
        RPC_TIMEOUT
      );
      return result;
    } catch (error: any) {
      lastError = error;
      // Reset uid on auth-related errors so next attempt re-authenticates
      if (error?.message?.includes('auth') || error?.faultCode === 2) {
        uid = null;
      }
      if (attempt < MAX_RETRIES) {
        logger.warn({ error: error?.message, model, method, attempt: attempt + 1 }, 'Odoo RPC failed, retrying...');
        await sleep(RETRY_DELAY * (attempt + 1));
      }
    }
  }

  logger.error({ error: lastError, model, method }, 'Odoo execute_kw failed after retries');
  throw lastError;
}

/** Convenience: search_read */
export async function searchRead<T = Record<string, unknown>>(
  model: string,
  domain: unknown[],
  fields: string[],
  options: { limit?: number; offset?: number; order?: string } = {}
): Promise<T[]> {
  return execute_kw<T[]>(model, 'search_read', [domain], {
    fields,
    limit: options.limit ?? 500,
    offset: options.offset ?? 0,
    ...(options.order ? { order: options.order } : {}),
  });
}

/** Convenience: create */
export async function create(model: string, values: Record<string, unknown>): Promise<number> {
  return execute_kw<number>(model, 'create', [values]);
}

/** Convenience: write */
export async function write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
  return execute_kw<boolean>(model, 'write', [ids, values]);
}

/** Test connection */
export async function testConnection(): Promise<{ uid: number; serverVersion: string }> {
  const userId = await authenticate();
  const version = await new Promise<string>((resolve, reject) => {
    commonClient.methodCall('version', [], (error, value: any) => {
      if (error) return reject(error);
      resolve(value?.server_version ?? 'unknown');
    });
  });
  return { uid: userId, serverVersion: version };
}
