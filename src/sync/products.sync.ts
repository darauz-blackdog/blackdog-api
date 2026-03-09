import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync, getLastSyncTimestamp } from './sync-utils.js';

interface OdooProduct {
  id: number;
  name: string;
  list_price: number;
  categ_id: [number, string];
  type: string;
  default_code: string | false;
  barcode: string | false;
  website_description: string | false;
  write_date: string;
  qty_available: number;
  available_in_pos: boolean;
}

const ODOO_FIELDS = [
  'name', 'list_price', 'categ_id', 'type',
  'default_code', 'barcode', 'website_description', 'write_date',
  'qty_available', 'available_in_pos',
];

const BASE_DOMAIN = [
  ['type', 'in', ['consu', 'product']],
  ['list_price', '>', 0],
  ['available_in_pos', '=', true],
];

function mapProduct(p: OdooProduct) {
  return {
    id: p.id,
    name: p.name?.trim(),
    list_price: p.list_price,
    category_id: p.categ_id?.[0] ?? null,
    category_name: p.categ_id?.[1] ?? null,
    product_type: p.type,
    default_code: p.default_code || null,
    description: p.website_description || null,
    available_in_pos: p.available_in_pos ?? false,
    odoo_updated_at: p.write_date,
    synced_at: new Date().toISOString(),
  };
}

/**
 * Full sync: paginate through ALL products in Odoo and upsert to Supabase.
 * Called on first run or manually.
 */
export async function syncProductsFull(): Promise<number> {
  const start = Date.now();

  try {
    logger.info('Running FULL product sync (all products from Odoo)...');

    let allProducts: OdooProduct[] = [];
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const batch = await searchRead<OdooProduct>(
        'product.template',
        BASE_DOMAIN,
        ODOO_FIELDS,
        { limit: batchSize, offset, order: 'id asc' }
      );

      if (!batch || batch.length === 0) break;
      allProducts.push(...batch);
      logger.info({ fetched: batch.length, total: allProducts.length, offset }, 'Odoo product batch fetched');
      offset += batchSize;
      if (batch.length < batchSize) break;
    }

    logger.info({ total: allProducts.length }, 'Full product fetch complete');

    if (allProducts.length === 0) {
      await logSync('products_full', 'success', 0, Date.now() - start);
      return 0;
    }

    const rows = allProducts.map(mapProduct);

    // Upsert in batches of 100
    let synced = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error } = await supabase
        .from('products')
        .upsert(batch, { onConflict: 'id' });

      if (error) {
        logger.error({ error, batchIndex: i }, 'Failed to upsert product batch');
      } else {
        synced += batch.length;
      }
    }

    await logSync('products_full', 'success', synced, Date.now() - start);
    logger.info({ synced }, 'Full product sync complete');
    return synced;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('products_full', 'error', 0, Date.now() - start, message);
    throw err;
  }
}

/**
 * Incremental sync: only products modified since last sync.
 * Called every 5 minutes.
 */
export async function syncProducts(): Promise<number> {
  const start = Date.now();

  try {
    const lastSync = await getLastSyncTimestamp('products');

    const domain = [
      ...BASE_DOMAIN,
      ['write_date', '>', lastSync],
    ];

    // Paginate incremental too (in case many products changed)
    let allProducts: OdooProduct[] = [];
    let offset = 0;

    while (true) {
      const batch = await searchRead<OdooProduct>(
        'product.template',
        domain,
        ODOO_FIELDS,
        { limit: 500, offset, order: 'id asc' }
      );

      if (!batch || batch.length === 0) break;
      allProducts.push(...batch);
      offset += 500;
      if (batch.length < 500) break;
    }

    if (allProducts.length === 0) {
      await logSync('products', 'success', 0, Date.now() - start);
      return 0;
    }

    const rows = allProducts.map(mapProduct);

    let synced = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error } = await supabase
        .from('products')
        .upsert(batch, { onConflict: 'id' });

      if (error) {
        logger.error({ error, batchIndex: i }, 'Failed to upsert product batch');
      } else {
        synced += batch.length;
      }
    }

    await logSync('products', 'success', synced, Date.now() - start);
    return synced;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('products', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
