import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

/**
 * Maps Odoo category_name paths to app_category_id (1-14) and extracts brand.
 * Runs after product sync to populate app_category_id and brand columns.
 */

interface CategoryRule {
  appCategoryId: number;
  match: (path: string) => boolean;
}

const CATEGORY_RULES: CategoryRule[] = [
  // Order matters: more specific rules first

  // 3 - Treats & Snacks (before Alimentos Perro/Gato)
  {
    appCategoryId: 3,
    match: (p) => p.includes('Alimentos') && (p.includes('Treats') || p.includes('Moz Pet')),
  },

  // 1 - Alimentos Perro
  {
    appCategoryId: 1,
    match: (p) => p.includes('Alimentos') && p.includes('Perro'),
  },

  // 2 - Alimentos Gato
  {
    appCategoryId: 2,
    match: (p) => p.includes('Alimentos') && p.includes('Gato'),
  },

  // 9 - Arena & Areneros (before Higiene to catch "Gatos - Arenero")
  {
    appCategoryId: 9,
    match: (p) => p.includes('/ Arena') || p.includes('Gatos - Arenero'),
  },

  // 12 - Pañales & Pads (before general Higiene)
  {
    appCategoryId: 12,
    match: (p) => p.includes('Pampers') || p.includes('/ Pads') || p.includes('Bolsas de Pupu'),
  },

  // 5 - Higiene & Cuidado
  {
    appCategoryId: 5,
    match: (p) =>
      p.includes('Higiene') && !p.includes('Gatos - Arenero') && !p.includes('Pampers') &&
      !p.includes('/ Pads') && !p.includes('Bolsas de Pupu'),
  },

  // 4 - Juguetes
  {
    appCategoryId: 4,
    match: (p) => p.includes('Juguetes'),
  },

  // 6 - Camas & Hogar
  {
    appCategoryId: 6,
    match: (p) => p.includes('/ Camas'),
  },

  // 7 - Collares & Correas
  {
    appCategoryId: 7,
    match: (p) => p.includes('Pecheras, Correas y Collares'),
  },

  // 8 - Bowls & Comederos
  {
    appCategoryId: 8,
    match: (p) => p.includes('Bowls y Feeders') || p.includes('Bebederos y Comederos'),
  },

  // 10 - Rascadores & Gimnasios
  {
    appCategoryId: 10,
    match: (p) => p.includes('Gimnasios y Rascadores') || p.includes('Rascadores'),
  },

  // 11 - Bolsos & Transporte
  {
    appCategoryId: 11,
    match: (p) => p.includes('/ Bolsos') || p.includes('Carritos') || p.includes('Kennels'),
  },

  // 13 - Medicamentos
  {
    appCategoryId: 13,
    match: (p) => p.includes('Medicamentos') || p.includes('Insumos Médicos'),
  },

  // 14 - Ropa & Accesorios (catch-all for remaining accessories)
  {
    appCategoryId: 14,
    match: (p) =>
      p.includes('/ Medias') || p.includes('Plaquitas') ||
      (p.includes('Accesorios') && p.includes('/ Otros')) ||
      // Generic "Accesorios / Perro" or "Accesorios" without specific subcategory
      (p.includes('Accesorios') && !p.includes('Higiene') && !p.includes('Juguetes') &&
       !p.includes('Camas') && !p.includes('Pecheras') && !p.includes('Bowls') &&
       !p.includes('Arena') && !p.includes('Gimnasios') && !p.includes('Bolsos') &&
       !p.includes('Carritos') && !p.includes('Kennels') && !p.includes('Pampers') &&
       !p.includes('/ Pads') && !p.includes('Bolsas de Pupu')),
  },

  // 5 - Insumos Peluqueria → Higiene & Cuidado
  {
    appCategoryId: 5,
    match: (p) => p.includes('Insumos Peluqueria'),
  },
];

/**
 * Extracts brand from category_name path.
 * For food: "Todos / Vendibles / Alimentos / Perro / Hills / Normal" → "Hills"
 * For treats: "Todos / Vendibles / Alimentos / Treats / Gosbi" → "Gosbi"
 * For meds: "Todos / Vendibles / Medicamentos / Calier" → "Calier"
 * For collars: "... / Pecheras, Correas y Collares / Alcott" → "Alcott"
 */
function extractBrand(categoryName: string): string | null {
  if (!categoryName || categoryName === 'false') return null;

  const parts = categoryName.split(' / ').map(s => s.trim());

  // Alimentos / Perro / {Brand} / ...
  if (categoryName.includes('Alimentos') && categoryName.includes('Perro')) {
    const idx = parts.indexOf('Perro');
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  // Alimentos / Gato / {Brand} / ...
  if (categoryName.includes('Alimentos') && categoryName.includes('Gato')) {
    const idx = parts.indexOf('Gato');
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  // Alimentos / Treats / {Brand}
  if (categoryName.includes('Treats')) {
    const idx = parts.indexOf('Treats');
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  // Alimentos / Moz Pet
  if (categoryName.includes('Moz Pet')) {
    return 'Moz Pet';
  }

  // Medicamentos / {Brand}
  if (categoryName.includes('Medicamentos')) {
    const idx = parts.findIndex(p => p === 'Medicamentos' || p.startsWith('Medicamentos'));
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  // Pecheras, Correas y Collares / {Brand}
  if (categoryName.includes('Pecheras, Correas y Collares')) {
    const idx = parts.indexOf('Pecheras, Correas y Collares');
    if (idx >= 0 && idx + 1 < parts.length) {
      return parts[idx + 1];
    }
  }

  return null;
}

function mapProductToCategory(categoryName: string): number | null {
  if (!categoryName || categoryName === 'false') return null;

  for (const rule of CATEGORY_RULES) {
    if (rule.match(categoryName)) {
      return rule.appCategoryId;
    }
  }

  return null;
}

/**
 * Sync category mapping: reads all products, maps each to app_category_id and brand,
 * then batch-updates the products table.
 */
export async function syncCategoryMapping(): Promise<number> {
  const start = Date.now();

  try {
    logger.info('Running category mapping sync...');

    // Fetch all products with their category_name
    let allProducts: { id: number; category_name: string | null }[] = [];
    let offset = 0;
    const pageSize = 1000;

    while (true) {
      const { data, error } = await supabase
        .from('products')
        .select('id, category_name')
        .range(offset, offset + pageSize - 1);

      if (error) {
        logger.error({ error }, 'Failed to fetch products for category mapping');
        break;
      }

      if (!data || data.length === 0) break;
      allProducts.push(...data);
      offset += pageSize;
      if (data.length < pageSize) break;
    }

    logger.info({ total: allProducts.length }, 'Products fetched for category mapping');

    if (allProducts.length === 0) {
      await logSync('category_mapping', 'success', 0, Date.now() - start);
      return 0;
    }

    // Map each product
    let updated = 0;
    const batchSize = 100;
    const updates: { id: number; app_category_id: number | null; brand: string | null }[] = [];

    for (const p of allProducts) {
      const catName = p.category_name ?? '';
      updates.push({
        id: p.id,
        app_category_id: mapProductToCategory(catName),
        brand: extractBrand(catName),
      });
    }

    // Batch upsert
    for (let i = 0; i < updates.length; i += batchSize) {
      const batch = updates.slice(i, i + batchSize);
      const { error } = await supabase
        .from('products')
        .upsert(batch, { onConflict: 'id', ignoreDuplicates: false });

      if (error) {
        logger.error({ error, batchIndex: i }, 'Failed to update category mapping batch');
      } else {
        updated += batch.length;
      }
    }

    await logSync('category_mapping', 'success', updated, Date.now() - start);
    logger.info({ updated }, 'Category mapping sync complete');
    return updated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logSync('category_mapping', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
