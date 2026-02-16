import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { logSync } from './sync-utils.js';

const SHOPIFY_STORE_URL = 'https://www.blackdogpanama.com';
const PAGE_SIZE = 250; // Shopify max per page

interface ShopifyImage {
  id: number;
  src: string;
  width?: number;
  height?: number;
}

interface ShopifyVariant {
  id: number;
  sku: string;
  price: string;
  compare_at_price: string | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  handle: string;
  body_html: string | null;
  tags: string;
  images: ShopifyImage[];
  variants: ShopifyVariant[];
  published_at: string | null;
}

/**
 * Fetch all products from Shopify's public JSON API.
 * Paginates through all pages (250 per page).
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

    // Small delay to be polite
    await new Promise(r => setTimeout(r, 500));
  }

  return allProducts;
}

/**
 * Build a lookup map from existing products in Supabase.
 * We match by default_code (SKU) first, then by normalized name.
 */
async function buildProductLookup(): Promise<{
  bySku: Map<string, number>;
  byName: Map<string, number>;
}> {
  const bySku = new Map<string, number>();
  const byName = new Map<string, number>();

  // Fetch all products (id, name, default_code) in pages
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
 * Main sync: fetch Shopify products, match to Supabase, enrich with images/description/tags.
 */
export async function syncShopify(): Promise<number> {
  const start = Date.now();

  try {
    logger.info('Starting Shopify sync...');

    const shopifyProducts = await fetchAllShopifyProducts();
    logger.info({ count: shopifyProducts.length }, 'Fetched Shopify products');

    if (shopifyProducts.length === 0) {
      await logSync('shopify', 'success', 0, Date.now() - start);
      return 0;
    }

    const { bySku, byName } = await buildProductLookup();
    logger.info({ skuCount: bySku.size, nameCount: byName.size }, 'Built product lookup');

    // Match and prepare updates
    let matched = 0;
    let unmatched = 0;
    const updates: Array<{
      id: number;
      shopify_id: number;
      description_html: string | null;
      tags: string[];
      image_urls: string[];
      handle: string;
    }> = [];

    for (const sp of shopifyProducts) {
      // Try to match: first by SKU from any variant, then by name
      let productId: number | undefined;

      // Check SKUs from variants
      for (const v of sp.variants) {
        if (v.sku) {
          productId = bySku.get(v.sku.trim().toUpperCase());
          if (productId) break;
        }
      }

      // Fallback: match by normalized name
      if (!productId) {
        productId = byName.get(normalizeName(sp.title));
      }

      if (!productId) {
        unmatched++;
        continue;
      }

      matched++;

      // Parse tags (Shopify usually sends comma-separated string, but may send array)
      let tags: string[] = [];
      if (Array.isArray(sp.tags)) {
        tags = sp.tags.map((t: string) => String(t).trim()).filter(Boolean);
      } else if (typeof sp.tags === 'string' && sp.tags) {
        tags = sp.tags.split(',').map(t => t.trim()).filter(Boolean);
      }

      // Get image URLs (use Shopify CDN URLs)
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

    logger.info({ matched, unmatched }, 'Shopify product matching complete');

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

    logger.info({ synced, total: updates.length }, 'Shopify sync upsert complete');
    await logSync('shopify', 'success', synced, Date.now() - start);
    return synced;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err }, 'Shopify sync failed');
    await logSync('shopify', 'error', 0, Date.now() - start, message);
    throw err;
  }
}
