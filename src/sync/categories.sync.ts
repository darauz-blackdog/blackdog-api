import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

interface OdooCategory {
  id: number;
  name: string;
  parent_id: [number, string] | false;
  complete_name: string;
}

// Only sync retail categories under "Vendibles"
const VENDIBLES_ID = 9;

export async function syncCategories(): Promise<number> {
  const start = Date.now();

  try {
    // Fetch all categories under "Vendibles"
    const categories = await searchRead<OdooCategory>(
      'product.category',
      [['id', 'child_of', VENDIBLES_ID]],
      ['name', 'parent_id', 'complete_name'],
      { limit: 200 }
    );

    if (categories.length === 0) {
      await logSync('categories', 'success', 0, Date.now() - start);
      return 0;
    }

    const rows = categories.map((c, idx) => ({
      id: c.id,
      name: c.name,
      parent_id: c.parent_id ? c.parent_id[0] : null,
      full_path: c.complete_name,
      sort_order: idx,
      synced_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from('categories')
      .upsert(rows, { onConflict: 'id' });

    if (error) {
      logger.error({ error }, 'Failed to upsert categories');
      await logSync('categories', 'error', 0, Date.now() - start, error.message);
      return 0;
    }

    await logSync('categories', 'success', rows.length, Date.now() - start);
    return rows.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('categories', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
