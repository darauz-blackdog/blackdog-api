import xmlrpc from 'xmlrpc';
import { env } from './env.js';
import { logger } from './logger.js';

const url = new URL(env.ODOO_URL);
const isSecure = url.protocol === 'https:';

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

/** Authenticate and get the user ID */
export async function authenticate(): Promise<number> {
  if (uid) return uid;

  return new Promise((resolve, reject) => {
    commonClient.methodCall(
      'authenticate',
      [env.ODOO_DB, env.ODOO_USERNAME, env.ODOO_PASSWORD, {}],
      (error, value) => {
        if (error) {
          logger.error({ error }, 'Odoo authentication failed');
          return reject(error);
        }
        if (!value || value === false) {
          return reject(new Error('Odoo authentication returned false — check credentials'));
        }
        uid = value as number;
        logger.info({ uid }, 'Authenticated with Odoo');
        resolve(uid);
      }
    );
  });
}

/** Execute a method on an Odoo model */
export async function execute_kw<T = unknown>(
  model: string,
  method: string,
  args: unknown[],
  kwargs: Record<string, unknown> = {}
): Promise<T> {
  const userId = await authenticate();

  return new Promise((resolve, reject) => {
    objectClient.methodCall(
      'execute_kw',
      [env.ODOO_DB, userId, env.ODOO_PASSWORD, model, method, args, kwargs],
      (error, value) => {
        if (error) {
          logger.error({ error, model, method }, 'Odoo execute_kw failed');
          return reject(error);
        }
        resolve(value as T);
      }
    );
  });
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
