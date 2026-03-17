import { searchRead } from '../config/odoo.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

const SHOPIFY_STORE_URL = 'https://www.blackdogpanama.com';
const PAGE_SIZE = 250; // Shopify max per page

interface ShopifyImage {
  id: number;
  src: string;
}

interface ShopifyVariant {
  id: number;
  sku: string;
  price: string;
  compare_at_price: string | null;
  barcode: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  tags: string | string[];
  images: ShopifyImage[];
  variants: ShopifyVariant[];
}

interface OdooShopifyMapping {
  shopify_tmpl_id: string;
  product_tmpl_id: [number, string] | false;
}

/**
 * Fetch all products from Shopify's public JSON API.
 */
async function fetchAllShopifyProducts(): Promise<ShopifyProduct[]> {
  const allProducts: ShopifyProduct[] = [];
  let page = 1;

  while (true) {
    const url = `${SHOPIFY_STORE_URL}/products.json?limit=${PAGE_SIZE}&page=${page}`;
    const res = await fetch(url);

    if (!res.ok) {
      throw new Error(`Shopify API error: ${res.status} ${res.statusText}`);
    }

    const json = await res.json() as { products: ShopifyProduct[] };
    if (!json.products || json.products.length === 0) break;

    allProducts.push(...json.products);
    logger.info({ page, fetched: json.products.length, total: allProducts.length }, 'Shopify page fetched');

    if (json.products.length < PAGE_SIZE) break;
    page++;
    await new Promise(r => setTimeout(r, 500));
  }

  return allProducts;
}

/**
 * Fetch Shopify→Odoo product mapping from Odoo's shopify.product.template.ept model.
 * Returns a map: Shopify template ID (string) → Odoo product.template ID (number)
 */
async function fetchOdooShopifyMapping(): Promise<Map<string, number>> {
  const map = new Map<string, number>();

  try {
    let offset = 0;
    const batchSize = 500;

    while (true) {
      const records = await searchRead<OdooShopifyMapping>(
        'shopify.product.template.ept',
        [['exported_in_shopify', '=', true]],
        ['shopify_tmpl_id', 'product_tmpl_id'],
        { limit: batchSize, offset }
      );

      if (!records || records.length === 0) break;

      for (const r of records) {
        if (r.shopify_tmpl_id && r.product_tmpl_id && (r.product_tmpl_id as unknown) !== false) {
          const odooId = Array.isArray(r.product_tmpl_id) ? r.product_tmpl_id[0] : r.product_tmpl_id;
          map.set(r.shopify_tmpl_id, odooId as number);
        }
      }

      offset += batchSize;
      if (records.length < batchSize) break;
    }

    logger.info({ count: map.size }, 'Fetched Odoo→Shopify mapping');
  } catch (err) {
    logger.error({ err }, 'Failed to fetch Odoo→Shopify mapping, falling back to SKU/name matching');
  }

  return map;
}

/**
 * Build a fallback lookup map from existing products in Supabase (by SKU and name).
 */
async function buildFallbackLookup(): Promise<{
  bySku: Map<string, number>;
  byName: Map<string, number>;
}> {
  const bySku = new Map<string, number>();
  const byName = new Map<string, number>();

  let offset = 0;
  const pageSize = 1000;

  while (true) {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, default_code')
      .range(offset, offset + pageSize - 1);

    if (error) {
      logger.error({ error }, 'Failed to fetch products for lookup');
      break;
    }
    if (!data || data.length === 0) break;

    for (const p of data) {
      if (p.default_code) {
        bySku.set(p.default_code.trim().toUpperCase(), p.id);
      }
      if (p.name) {
        byName.set(normalizeName(p.name), p.id);
      }
    }

    offset += pageSize;
    if (data.length < pageSize) break;
  }

  return { bySku, byName };
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Main sync: fetch Shopify products, match to Supabase via Odoo mapping + fallback, enrich.
 */
export async function syncShopify(): Promise<number> {
  const start = Date.now();

  try {
    logger.info('Starting Shopify sync...');

    // Fetch data from all three sources in parallel
    const [shopifyProducts, odooMapping, fallback] = await Promise.all([
      fetchAllShopifyProducts(),
      fetchOdooShopifyMapping(),
      buildFallbackLookup(),
    ]);

    logger.info({
      shopify: shopifyProducts.length,
      odooMap: odooMapping.size,
      skus: fallback.bySku.size,
      names: fallback.byName.size,
    }, 'All data fetched for matching');

    if (shopifyProducts.length === 0) {
      await logSync('shopify', 'success', 0, Date.now() - start);
      return 0;
    }

    // Build set of existing product IDs in Supabase for validation
    const existingIds = new Set<number>();
    let offset = 0;
    while (true) {
      const { data } = await supabase
        .from('products')
        .select('id')
        .range(offset, offset + 999);
      if (!data || data.length === 0) break;
      for (const p of data) existingIds.add(p.id);
      offset += 1000;
      if (data.length < 1000) break;
    }

    // Match and prepare updates
    let matchedByOdoo = 0;
    let matchedBySku = 0;
    let matchedByName = 0;
    let unmatched = 0;

    const updates: Array<{
      id: number;
      shopify_id: number;
      description_html: string | null;
      tags: string[];
      image_urls: string[];
      handle: string;
    }> = [];

    // Track already-matched product IDs to avoid duplicates
    const matchedProductIds = new Set<number>();

    for (const sp of shopifyProducts) {
      let productId: number | undefined;
      let matchMethod = '';

      // 1. Primary: Odoo direct mapping (shopify_tmpl_id → product_tmpl_id)
      const odooId = odooMapping.get(String(sp.id));
      if (odooId && existingIds.has(odooId)) {
        productId = odooId;
        matchMethod = 'odoo';
      }

      // 2. Fallback: match by SKU from variants
      if (!productId) {
        for (const v of sp.variants) {
          if (v.sku) {
            productId = fallback.bySku.get(v.sku.trim().toUpperCase());
            if (productId) {
              matchMethod = 'sku';
              break;
            }
          }
        }
      }

      // 3. Last resort: match by normalized name
      if (!productId) {
        productId = fallback.byName.get(normalizeName(sp.title));
        if (productId) matchMethod = 'name';
      }

      if (!productId || matchedProductIds.has(productId)) {
        unmatched++;
        continue;
      }

      matchedProductIds.add(productId);
      if (matchMethod === 'odoo') matchedByOdoo++;
      else if (matchMethod === 'sku') matchedBySku++;
      else matchedByName++;

      // Parse tags
      let tags: string[] = [];
      if (Array.isArray(sp.tags)) {
        tags = sp.tags.map((t: string) => String(t).trim()).filter(Boolean);
      } else if (typeof sp.tags === 'string' && sp.tags) {
        tags = sp.tags.split(',').map(t => t.trim()).filter(Boolean);
      }

      const imageUrls = sp.images.map(img => img.src);

      updates.push({
        id: productId,
        shopify_id: sp.id,
        description_html: sp.body_html || null,
        tags,
        image_urls: imageUrls,
        handle: sp.handle,
      });
    }

    logger.info({
      total: matchedByOdoo + matchedBySku + matchedByName,
      byOdoo: matchedByOdoo,
      bySku: matchedBySku,
      byName: matchedByName,
      unmatched,
    }, 'Shopify product matching complete');

    // Update existing products in parallel batches of 20
    let synced = 0;
    for (let i = 0; i < updates.length; i += 20) {
      const batch = updates.slice(i, i + 20);
      const results = await Promise.allSettled(
        batch.map(({ id, ...fields }) =>
          supabase.from('products').update(fields).eq('id', id)
        )
      );

      for (const r of results) {
        if (r.status === 'fulfilled' && !r.value.error) {
          synced++;
        } else if (r.status === 'fulfilled' && r.value.error) {
          logger.error({ error: r.value.error }, 'Failed to update product with Shopify data');
        }
      }
    }

    logger.info({ synced, total: updates.length }, 'Shopify sync complete');
    await logSync('shopify', 'success', synced, Date.now() - start);
    return synced;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Shopify sync failed');
    await logSync('shopify', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
