import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync, getLastSyncTimestamp } from './sync-utils.js';

// Category IDs that are retail (Alimentos, Accesorios, Treats, Humano)
// These are parent categories — includes all children
const RETAIL_PARENT_IDS = [5, 6, 288]; // Accesorios, Alimentos, Humano

interface OdooProduct {
  id: number;
  name: string;
  list_price: number;
  categ_id: [number, string];
  type: string;
  default_code: string | false;
  website_description: string | false;
  write_date: string;
  qty_available: number;
}

export async function syncProducts(): Promise<number> {
  const start = Date.now();

  try {
    const lastSync = await getLastSyncTimestamp('products');

    // Fetch products modified since last sync
    const products = await searchRead<OdooProduct>(
      'product.template',
      [
        ['type', 'in', ['consu', 'product']],
        ['list_price', '>', 0],
        ['write_date', '>', lastSync],
      ],
      [
        'name', 'list_price', 'categ_id', 'type',
        'default_code', 'website_description', 'write_date',
        'qty_available',
      ],
      { limit: 1000 }
    );

    if (products.length === 0) {
      await logSync('products', 'success', 0, Date.now() - start);
      return 0;
    }

    // Prepare upsert data
    const rows = products.map(p => ({
      id: p.id,
      name: p.name?.trim(),
      list_price: p.list_price,
      category_id: p.categ_id?.[0] ?? null,
      category_name: p.categ_id?.[1] ?? null,
      product_type: p.type,
      default_code: p.default_code || null,
      description: p.website_description || null,
      is_published: true,
      odoo_updated_at: p.write_date,
      synced_at: new Date().toISOString(),
    }));

    // Upsert in batches of 100
    let synced = 0;
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100);
      const { error } = await supabase
        .from('products')
        .upsert(batch, { onConflict: 'id' });

      if (error) {
        logger.error({ error, batch: i }, 'Failed to upsert product batch');
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
