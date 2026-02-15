import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

interface OdooQuant {
  id: number;
  product_id: [number, string];
  location_id: [number, string];
  quantity: number;
}

// Warehouse IDs that are actual stores (exclude bodegas, consumo interno, descarte)
const STORE_WAREHOUSE_IDS = [1, 3, 4, 6, 7, 8, 10, 15, 16, 17, 18, 21, 22, 23, 29, 30, 31];

export async function syncStock(): Promise<number> {
  const start = Date.now();

  try {
    // Fetch stock quants for store warehouses with positive quantity
    const quants = await searchRead<OdooQuant>(
      'stock.quant',
      [
        ['location_id.warehouse_id', 'in', STORE_WAREHOUSE_IDS],
        ['quantity', '>', 0],
        ['location_id.usage', '=', 'internal'],
      ],
      ['product_id', 'location_id', 'quantity'],
      { limit: 50000 }
    );

    if (quants.length === 0) {
      await logSync('stock', 'success', 0, Date.now() - start);
      return 0;
    }

    // We need to map location_id → warehouse_id
    // First, get the location → warehouse mapping
    const locationIds = [...new Set(quants.map(q => q.location_id[0]))];
    const locations = await searchRead<{ id: number; warehouse_id: [number, string] | false }>(
      'stock.location',
      [['id', 'in', locationIds]],
      ['warehouse_id'],
      { limit: 500 }
    );

    const locationToWarehouse = new Map<number, number>();
    for (const loc of locations) {
      if (loc.warehouse_id) {
        locationToWarehouse.set(loc.id, loc.warehouse_id[0]);
      }
    }

    // Aggregate stock per product per warehouse
    const stockMap = new Map<string, { product_id: number; branch_id: number; qty: number }>();

    for (const q of quants) {
      const warehouseId = locationToWarehouse.get(q.location_id[0]);
      if (!warehouseId || !STORE_WAREHOUSE_IDS.includes(warehouseId)) continue;

      const key = `${q.product_id[0]}-${warehouseId}`;
      const existing = stockMap.get(key);
      if (existing) {
        existing.qty += q.quantity;
      } else {
        stockMap.set(key, {
          product_id: q.product_id[0],
          branch_id: warehouseId,
          qty: q.quantity,
        });
      }
    }

    const rows = Array.from(stockMap.values()).map(s => ({
      product_id: s.product_id,
      branch_id: s.branch_id,
      qty_available: s.qty,
      synced_at: new Date().toISOString(),
    }));

    // Upsert in batches
    let synced = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase
        .from('stock_by_branch')
        .upsert(batch, { onConflict: 'product_id,branch_id' });

      if (error) {
        logger.error({ error, batch: i }, 'Failed to upsert stock batch');
      } else {
        synced += batch.length;
      }
    }

    await logSync('stock', 'success', synced, Date.now() - start);
    return synced;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('stock', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
