import { Router } from 'express';
import { testConnection } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { env } from '../config/env.js';

const router = Router();

router.get('/health', async (_req, res) => {
  const checks: Record<string, string> = { api: 'ok' };

  try {
    const odoo = await testConnection();
    checks.odoo = `connected (v${odoo.serverVersion}, uid=${odoo.uid})`;
  } catch {
    checks.odoo = 'error';
  }

  try {
    const { error } = await supabase.from('sync_logs').select('id').limit(1);
    checks.supabase = error ? `error: ${error.message}` : 'connected';
  } catch {
    checks.supabase = 'error';
  }

  const allOk = !Object.values(checks).some(v => v.includes('error'));

  res.status(allOk ? 200 : 503).json({
    status: allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * Detailed status endpoint for admin panel.
 * Returns Odoo DB info, Tilopay health, Supabase health, and Yappy config status.
 */
router.get('/admin/status', async (_req, res) => {
  const result: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
  };

  // -- Odoo --
  try {
    const odoo = await testConnection();
    result.odoo = {
      status: 'connected',
      database: env.ODOO_DB,
      url: env.ODOO_URL,
      serverVersion: odoo.serverVersion,
      uid: odoo.uid,
    };
  } catch (err: any) {
    result.odoo = {
      status: 'error',
      database: env.ODOO_DB,
      url: env.ODOO_URL,
      error: err?.message ?? 'Unknown error',
    };
  }

  // -- Supabase --
  try {
    const { count, error } = await supabase.from('orders').select('*', { count: 'exact', head: true });
    result.supabase = {
      status: error ? 'error' : 'connected',
      url: env.SUPABASE_URL,
      ...(error ? { error: error.message } : { ordersCount: count }),
    };
  } catch (err: any) {
    result.supabase = {
      status: 'error',
      url: env.SUPABASE_URL,
      error: err?.message ?? 'Unknown error',
    };
  }

  // -- Tilopay --
  try {
    const loginRes = await fetch(
      `${env.TILOPAY_API_BASE_URL.replace(/\/$/, '')}/api/v1/login`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiuser: env.TILOPAY_API_USER, password: env.TILOPAY_API_PASSWORD }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    const data = await loginRes.json();
    result.tilopay = {
      status: data.access_token ? 'connected' : 'auth_failed',
      baseUrl: env.TILOPAY_API_BASE_URL,
      redirectUrl: env.TILOPAY_REDIRECT_URL,
      configured: !!(env.TILOPAY_API_USER && env.TILOPAY_API_PASSWORD && env.TILOPAY_API_KEY),
    };
  } catch (err: any) {
    result.tilopay = {
      status: 'error',
      baseUrl: env.TILOPAY_API_BASE_URL,
      redirectUrl: env.TILOPAY_REDIRECT_URL,
      configured: !!(env.TILOPAY_API_USER && env.TILOPAY_API_PASSWORD && env.TILOPAY_API_KEY),
      error: err?.message ?? 'Unknown error',
    };
  }

  res.json(result);
});

export default router;
