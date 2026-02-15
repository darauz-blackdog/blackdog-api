import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

interface OdooWarehouse {
  id: number;
  name: string;
  code: string;
  partner_id: [number, string];
}

interface OdooPartner {
  id: number;
  street: string | false;
  city: string | false;
  phone: string | false;
  email: string | false;
  partner_latitude: number;
  partner_longitude: number;
}

// Only sync actual stores
const STORE_WAREHOUSE_IDS = [1, 3, 4, 6, 7, 8, 10, 15, 16, 17, 18, 21, 22, 23, 29, 30, 31];

export async function syncBranches(): Promise<number> {
  const start = Date.now();

  try {
    const warehouses = await searchRead<OdooWarehouse>(
      'stock.warehouse',
      [['id', 'in', STORE_WAREHOUSE_IDS]],
      ['name', 'code', 'partner_id'],
      { limit: 50 }
    );

    // Fetch partner (address) data for each warehouse
    const partnerIds = warehouses.map(w => w.partner_id[0]);
    const partners = await searchRead<OdooPartner>(
      'res.partner',
      [['id', 'in', partnerIds]],
      ['street', 'city', 'phone', 'email', 'partner_latitude', 'partner_longitude'],
      { limit: 50 }
    );

    const partnerMap = new Map(partners.map(p => [p.id, p]));

    const rows = warehouses.map(w => {
      const partner = partnerMap.get(w.partner_id[0]);
      return {
        id: w.id,
        name: w.name,
        code: w.code,
        address: partner?.street || null,
        city: partner?.city || null,
        phone: partner?.phone || null,
        email: partner?.email || null,
        latitude: partner?.partner_latitude || null,
        longitude: partner?.partner_longitude || null,
        is_pickup_enabled: true,
        is_delivery_enabled: true,
        synced_at: new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .from('branches')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      logger.error({ error }, 'Failed to upsert branches');
      await logSync('branches', 'error', 0, Date.now() - start, error.message);
      return 0;
    }

    await logSync('branches', 'success', rows.length, Date.now() - start);
    return rows.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('branches', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
