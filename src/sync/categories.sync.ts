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

    // Sort: parents first (no parent_id), then children
    // This avoids FK constraint violations on self-referencing parent_id
    const sorted = categories.sort((a, b) => {
      const aDepth = (a.complete_name?.match(/\//g) || []).length;
      const bDepth = (b.complete_name?.match(/\//g) || []).length;
      return aDepth - bDepth;
    });

    // Insert in batches by depth level to respect FK ordering
    const categoryIds = new Set(sorted.map(c => c.id));
    let synced = 0;

    for (const cat of sorted) {
      const parentId = cat.parent_id ? cat.parent_id[0] : null;
      const row = {
        id: cat.id,
        name: cat.name,
        parent_id: parentId && categoryIds.has(parentId) ? parentId : null,
        full_path: cat.complete_name,
        sort_order: synced,
        synced_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from('categories')
        .upsert(row, { onConflict: 'id' });

      if (error) {
        logger.warn({ error, categoryId: cat.id }, 'Failed to upsert category');
      } else {
        synced++;
      }
    }

    await logSync('categories', 'success', synced, Date.now() - start);
    return rows.length;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('categories', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
