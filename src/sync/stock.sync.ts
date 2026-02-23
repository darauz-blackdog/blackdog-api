import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

interface OdooQuant {
  id: number;
  product_id: [number, string];
  location_id: [number, string];
  quantity: number;
  reserved_quantity: number;
}

// Warehouse IDs matching Shopify locations (source of truth for stock export)
const STORE_WAREHOUSE_IDS = [1, 3, 4, 7, 8, 15, 16, 17, 21, 23];

export async function syncStock(): Promise<number> {
  const start = Date.now();

  try {
    // Step 1: Fetch lot_stock_id for each warehouse to get the correct stock location IDs.
    // We can't rely on location.warehouse_id because Odoo reassigned some locations to "Sitio web".
    const warehouses = await searchRead<{ id: number; lot_stock_id: [number, string] | false }>(
      'stock.warehouse',
      [['id', 'in', STORE_WAREHOUSE_IDS]],
      ['lot_stock_id'],
      { limit: 50 }
    );

    // Build location_id → warehouse_id map from the warehouse's stock location
    const locationToWarehouse = new Map<number, number>();
    const stockLocationIds: number[] = [];

    for (const wh of warehouses) {
      if (wh.lot_stock_id) {
        const locId = wh.lot_stock_id[0];
        locationToWarehouse.set(locId, wh.id);
        stockLocationIds.push(locId);
      }
    }

    if (stockLocationIds.length === 0) {
      logger.warn('No stock locations found for configured warehouses');
      await logSync('stock', 'success', 0, Date.now() - start);
      return 0;
    }

    logger.info({ warehouses: warehouses.length, locations: stockLocationIds.length }, 'Stock locations resolved');

    // Step 2: Fetch stock quants directly by location IDs (not via unreliable warehouse_id relation)
    const quants = await searchRead<OdooQuant>(
      'stock.quant',
      [
        ['location_id', 'in', stockLocationIds],
        ['quantity', '>', 0],
      ],
      ['product_id', 'location_id', 'quantity', 'reserved_quantity'],
      { limit: 50000 }
    );

    if (quants.length === 0) {
      await logSync('stock', 'success', 0, Date.now() - start);
      return 0;
    }

    // Step 3: Aggregate stock per product per warehouse using free quantity
    const stockMap = new Map<string, { product_id: number; branch_id: number; qty: number }>();

    for (const q of quants) {
      const warehouseId = locationToWarehouse.get(q.location_id[0]);
      if (!warehouseId) continue;

      // Use free quantity (on-hand minus reserved) to match Shopify export
      const freeQty = q.quantity - (q.reserved_quantity ?? 0);
      if (freeQty <= 0) continue;

      const key = `${q.product_id[0]}-${warehouseId}`;
      const existing = stockMap.get(key);
      if (existing) {
        existing.qty += freeQty;
      } else {
        stockMap.set(key, {
          product_id: q.product_id[0],
          branch_id: warehouseId,
          qty: freeQty,
        });
      }
    }

    const rows = Array.from(stockMap.values()).map(s => ({
      product_id: s.product_id,
      branch_id: s.branch_id,
      qty_available: s.qty,
      synced_at: new Date().toISOString(),
    }));

    // Clear all existing stock and replace with fresh data from Odoo.
    // This ensures products that went to 0 stock are properly reflected.
    const { error: deleteError } = await supabase
      .from('stock_by_branch')
      .delete()
      .gte('product_id', 0); // delete all rows

    if (deleteError) {
      logger.error({ deleteError }, 'Failed to clear stock_by_branch before sync');
    }

    // Insert fresh stock in batches
    let synced = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const batch = rows.slice(i, i + 500);
      const { error } = await supabase
        .from('stock_by_branch')
        .insert(batch);

      if (error) {
        logger.error({ error, batch: i }, 'Failed to insert stock batch');
      } else {
        synced += batch.length;
      }
    }

    // Refresh denormalized total_stock on products table
    const { error: rpcError } = await supabase.rpc('refresh_product_stock');
    if (rpcError) {
      logger.error({ rpcError }, 'Failed to refresh product stock totals');
    }

    await logSync('stock', 'success', synced, Date.now() - start);
    return synced;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('stock', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
