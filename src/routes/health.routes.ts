import { Router } from 'express';
import { testConnection } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';

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

export default router;
