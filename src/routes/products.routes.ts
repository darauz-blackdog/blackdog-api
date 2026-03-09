import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';

const router = Router();

/**
 * GET /api/app-categories
 * Returns the 14 simplified app categories with product counts
 */
router.get('/app-categories', async (req: Request, res: Response) => {
  try {
    const { data: categories, error } = await supabase
      .from('app_categories')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch app categories' });
      return;
    }

    // Get product counts per app_category using individual count queries (avoids 1000 row limit)
    const countMap = new Map<number, number>();
    const countPromises = (categories ?? []).map(async (c) => {
      const { count } = await supabase
        .from('products')
        .select('id', { count: 'exact', head: true })
        .eq('is_published', true)
        .eq('app_category_id', c.id);
      countMap.set(c.id, count ?? 0);
    });
    await Promise.all(countPromises);

    const enriched = (categories ?? []).map(c => ({
      ...c,
      product_count: countMap.get(c.id) ?? 0,
    }));

    res.json({ data: enriched });
  } catch (err) {
    logger.error({ err }, 'App categories error');
    res.status(500).json({ error: 'Failed to fetch app categories' });
  }
});

/**
 * GET /api/brands
 * Returns distinct brands, optionally filtered by app_category_id
 * Query params: app_category_id
 */
router.get('/brands', async (req: Request, res: Response) => {
  try {
    const appCategoryId = req.query.app_category_id
      ? parseInt(req.query.app_category_id as string)
      : null;

    let query = supabase
      .from('products')
      .select('brand')
      .eq('is_published', true)
      .not('brand', 'is', null);

    if (appCategoryId) {
      query = query.eq('app_category_id', appCategoryId);
    }

    const { data, error } = await query;

    if (error) {
      res.status(500).json({ error: 'Failed to fetch brands' });
      return;
    }

    // Extract unique brands and sort
    const brands = [...new Set((data ?? []).map(r => r.brand as string))].sort();

    res.json({ data: brands });
  } catch (err) {
    logger.error({ err }, 'Brands error');
    res.status(500).json({ error: 'Failed to fetch brands' });
  }
});

/**
 * GET /api/products
 * Paginated product list with optional category filter
 * Query params: category_id, app_category_id, brand, page (1-based), limit, sort
 */
router.get('/products', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string) || 40));
    const categoryId = req.query.category_id ? parseInt(req.query.category_id as string) : null;
    const appCategoryId = req.query.app_category_id ? parseInt(req.query.app_category_id as string) : null;
    const brand = req.query.brand ? (req.query.brand as string) : null;
    const sort = (req.query.sort as string) || 'name';

    // Build base filter (reused for count + data queries)
    const applyFilters = (q: any) => {
      q = q.eq('is_published', true);
      if (appCategoryId) {
        q = q.eq('app_category_id', appCategoryId);
      }
      if (brand) {
        q = q.eq('brand', brand);
      }
      return q;
    };

    // Handle category with descendants
    let descendantIds: number[] = [];
    if (!appCategoryId && categoryId) {
      descendantIds = await getDescendantCategoryIds(categoryId);
    }
    const applyCategoryFilter = (q: any) => {
      if (appCategoryId) return q;
      if (categoryId) {
        q = q.in('category_id', [categoryId, ...descendantIds]);
      }
      return q;
    };

    // --- Count deduplicated total ---
    // Fetch all variant_group values + count of products without variant_group
    let countQuery = supabase
      .from('products')
      .select('variant_group');
    countQuery = applyFilters(countQuery);
    countQuery = applyCategoryFilter(countQuery);
    const { data: allRows } = await countQuery;

    let deduplicatedTotal = 0;
    if (allRows) {
      const seenGroups = new Set<string>();
      for (const row of allRows) {
        if (!row.variant_group) {
          deduplicatedTotal++;
        } else if (!seenGroups.has(row.variant_group)) {
          seenGroups.add(row.variant_group);
          deduplicatedTotal++;
        }
      }
    }

    const totalPages = Math.ceil(deduplicatedTotal / limit);
    const offset = (page - 1) * limit;

    if (deduplicatedTotal === 0 || offset >= deduplicatedTotal) {
      res.json({
        data: [],
        pagination: { page, limit, total: deduplicatedTotal, total_pages: totalPages },
      });
      return;
    }

    // --- Fetch products with overfetch to account for deduplication ---
    // Overfetch 3x to ensure we get enough unique products after dedup
    const fetchLimit = limit * 3;
    const fetchOffset = Math.max(0, Math.floor(offset * 1.5)); // approximate start

    let dataQuery = supabase
      .from('products')
      .select('*')
      .eq('is_published', true);

    if (appCategoryId) {
      dataQuery = dataQuery.eq('app_category_id', appCategoryId);
    } else if (categoryId) {
      dataQuery = dataQuery.in('category_id', [categoryId, ...descendantIds]);
    }
    if (brand) {
      dataQuery = dataQuery.eq('brand', brand);
    }

    // Sort
    dataQuery = dataQuery.order('has_stock', { ascending: false });
    switch (sort) {
      case 'price_asc':
        dataQuery = dataQuery.order('list_price', { ascending: true });
        break;
      case 'price_desc':
        dataQuery = dataQuery.order('list_price', { ascending: false });
        break;
      case 'newest':
        dataQuery = dataQuery.order('synced_at', { ascending: false });
        break;
      default:
        dataQuery = dataQuery.order('name', { ascending: true });
    }

    // For page 1 start from 0; for later pages we need to scan from start
    // to correctly deduplicate (variant groups can span page boundaries)
    const scanLimit = offset + fetchLimit;
    dataQuery = dataQuery.range(0, scanLimit - 1);

    const { data: allProducts, error } = await dataQuery;

    if (error) {
      logger.error({ error }, 'Failed to fetch products');
      res.status(500).json({ error: 'Failed to fetch products' });
      return;
    }

    if (!allProducts || allProducts.length === 0) {
      res.json({
        data: [],
        pagination: { page, limit, total: deduplicatedTotal, total_pages: totalPages },
      });
      return;
    }

    // Deduplicate by variant_group
    const seenGroups = new Set<string>();
    const uniqueProducts: any[] = [];
    for (const p of allProducts) {
      if (!p.variant_group) {
        uniqueProducts.push(p);
      } else if (!seenGroups.has(p.variant_group)) {
        seenGroups.add(p.variant_group);
        uniqueProducts.push(p);
      }
    }

    // Slice for the requested page
    const pageProducts = uniqueProducts.slice(offset, offset + limit);

    if (pageProducts.length === 0) {
      res.json({
        data: [],
        pagination: { page, limit, total: deduplicatedTotal, total_pages: totalPages },
      });
      return;
    }

    // Fetch stock for page products
    const productIds = pageProducts.map(p => p.id);
    const { data: stockData } = await supabase
      .from('stock_by_branch')
      .select('product_id, qty_available')
      .in('product_id', productIds)
      .gt('qty_available', 0);

    const stockMap = new Map<number, number>();
    if (stockData) {
      for (const s of stockData) {
        const current = stockMap.get(s.product_id) ?? 0;
        stockMap.set(s.product_id, current + (s.qty_available ?? 0));
      }
    }

    const enrichedData = pageProducts.map(p => ({
      ...p,
      total_stock: stockMap.get(p.id) ?? 0,
    }));

    res.json({
      data: enrichedData,
      pagination: {
        page,
        limit,
        total: deduplicatedTotal,
        total_pages: totalPages,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Products list error');
    res.status(500).json({ error: 'Failed to fetch products' });
  }
});

/**
 * GET /api/products/search
 * Full-text search on product names (Spanish)
 * Query params: q, page, limit
 */
router.get('/products/search', async (req: Request, res: Response) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) {
      res.status(400).json({ error: 'Search query must be at least 2 characters' });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;

    // Use full-text search with Spanish config
    const tsQuery = q.split(/\s+/).map(w => `${w}:*`).join(' & ');

    // Fetch all matching results for dedup (search results are typically small)
    const scanLimit = offset + limit * 3;

    const { data: products, error } = await supabase
      .from('products')
      .select('*')
      .eq('is_published', true)
      .textSearch('name', tsQuery, { config: 'spanish' })
      .order('has_stock', { ascending: false })
      .range(0, scanLimit - 1);

    let finalProducts = products;

    if (error) {
      // Fallback to ILIKE if full-text search fails
      const { data: fallbackData, error: fallbackError } = await supabase
        .from('products')
        .select('*')
        .eq('is_published', true)
        .ilike('name', `%${q}%`)
        .order('has_stock', { ascending: false })
        .order('name')
        .range(0, scanLimit - 1);

      if (fallbackError) {
        res.status(500).json({ error: 'Search failed' });
        return;
      }
      finalProducts = fallbackData;
    }

    if (!finalProducts || finalProducts.length === 0) {
      res.json({
        data: [],
        pagination: { page, limit, total: 0, total_pages: 0 },
      });
      return;
    }

    // Deduplicate by variant_group
    const seenGroups = new Set<string>();
    const uniqueProducts = finalProducts.filter(p => {
      if (!p.variant_group) return true;
      if (seenGroups.has(p.variant_group)) return false;
      seenGroups.add(p.variant_group);
      return true;
    });

    const deduplicatedTotal = uniqueProducts.length;
    const totalPages = Math.ceil(deduplicatedTotal / limit);
    const pageProducts = uniqueProducts.slice(offset, offset + limit);

    if (pageProducts.length === 0) {
      res.json({
        data: [],
        pagination: { page, limit, total: deduplicatedTotal, total_pages: totalPages },
      });
      return;
    }

    // Fetch stock for page products
    const productIds = pageProducts.map(p => p.id);
    const { data: stockData } = await supabase
      .from('stock_by_branch')
      .select('product_id, qty_available')
      .in('product_id', productIds)
      .gt('qty_available', 0);

    const stockMap = new Map<number, number>();
    if (stockData) {
      for (const s of stockData) {
        const current = stockMap.get(s.product_id) ?? 0;
        stockMap.set(s.product_id, current + (s.qty_available ?? 0));
      }
    }

    const enrichedData = pageProducts.map(p => ({
      ...p,
      total_stock: stockMap.get(p.id) ?? 0,
    }));

    res.json({
      data: enrichedData,
      pagination: {
        page,
        limit,
        total: deduplicatedTotal,
        total_pages: totalPages,
      },
    });
  } catch (err) {
    logger.error({ err }, 'Product search error');
    res.status(500).json({ error: 'Search failed' });
  }
});

/**
 * GET /api/home/banners
 * Returns active banners for the home carousel
 */
router.get('/home/banners', async (req: Request, res: Response) => {
  try {
    const now = new Date().toISOString();
    const { data: banners, error } = await supabase
      .from('home_banners')
      .select('*')
      .eq('is_active', true)
      .or(`starts_at.is.null,starts_at.lte.${now}`)
      .or(`ends_at.is.null,ends_at.gte.${now}`)
      .order('sort_order', { ascending: true });

    if (error) {
      logger.error({ error }, 'Home banners error');
      res.status(500).json({ error: 'Failed to fetch banners' });
      return;
    }

    res.json({ banners: banners ?? [] });
  } catch (err) {
    logger.error({ err }, 'Home banners error');
    res.status(500).json({ error: 'Failed to fetch banners' });
  }
});

/**
 * GET /api/home/sections
 * Returns curated home screen sections (by brand or category) with products.
 * Reads section definitions from home_sections table.
 */
router.get('/home/sections', async (req: Request, res: Response) => {
  try {
    // Fetch active section definitions from DB
    const { data: sectionDefs, error: defError } = await supabase
      .from('home_sections')
      .select('*')
      .eq('is_active', true)
      .order('sort_order', { ascending: true });

    if (defError) {
      logger.error({ error: defError }, 'Failed to fetch home_sections config');
      res.status(500).json({ error: 'Failed to fetch home sections' });
      return;
    }

    if (!sectionDefs || sectionDefs.length === 0) {
      res.json({ sections: [] });
      return;
    }

    // Fetch all sections in parallel
    const sections = await Promise.all(
      sectionDefs.map(async (def) => {
        const SECTION_SIZE = def.max_products ?? 8;

        let query = supabase
          .from('products')
          .select('*')
          .eq('is_published', true)
          .eq('has_stock', true);

        if (def.type === 'brand') {
          query = query.eq('brand', def.filter_value);
        } else {
          query = query.eq('app_category_id', parseInt(def.filter_value));
        }

        // Get more than needed so we can deduplicate variants and shuffle
        const { data: products, error } = await query
          .order('synced_at', { ascending: false })
          .limit(60);

        if (error || !products || products.length === 0) {
          return null;
        }

        // Deduplicate by variant_group: keep only one product per group
        const seenGroups = new Set<string>();
        const unique = products.filter(p => {
          if (!p.variant_group) return true; // no group → always keep
          if (seenGroups.has(p.variant_group)) return false;
          seenGroups.add(p.variant_group);
          return true;
        });

        // Shuffle and pick SECTION_SIZE
        const shuffled = unique.sort(() => Math.random() - 0.5);
        const selected = shuffled.slice(0, SECTION_SIZE);

        // Fetch stock for selected products
        const productIds = selected.map(p => p.id);
        const { data: stockData } = await supabase
          .from('stock_by_branch')
          .select('product_id, qty_available')
          .in('product_id', productIds)
          .gt('qty_available', 0);

        const stockMap = new Map<number, number>();
        if (stockData) {
          for (const s of stockData) {
            const current = stockMap.get(s.product_id) ?? 0;
            stockMap.set(s.product_id, current + (s.qty_available ?? 0));
          }
        }

        const enriched = selected.map(p => ({
          ...p,
          total_stock: stockMap.get(p.id) ?? 0,
        }));

        const filter = def.type === 'brand'
          ? { brand: def.filter_value }
          : { app_category_id: parseInt(def.filter_value) };

        return {
          id: `${def.type}:${def.filter_value}`,
          title: def.title,
          type: def.type,
          filter,
          products: enriched,
        };
      })
    );

    // Filter out empty sections
    const validSections = sections.filter(s => s !== null);

    res.json({ sections: validSections });
  } catch (err) {
    logger.error({ err }, 'Home sections error');
    res.status(500).json({ error: 'Failed to fetch home sections' });
  }
});

/**
 * GET /api/products/featured
 * Returns featured/popular products (cheapest with stock for now)
 * Query params: limit
 */
router.get('/products/featured', async (req: Request, res: Response) => {
  try {
    const limit = Math.min(30, Math.max(1, parseInt(req.query.limit as string) || 12));
    const accumulated: any[] = [];
    let offset = 0;
    const batchSize = 50;
    const maxIterations = 10; // Safety break

    for (let i = 0; i < maxIterations; i++) {
      if (accumulated.length >= limit) break;

      // Fetch batch of products ordered by price
      const { data: products, error } = await supabase
        .from('products')
        .select('*')
        .eq('is_published', true)
        .order('list_price', { ascending: true })
        .range(offset, offset + batchSize - 1);

      if (error) {
        throw error;
      }

      if (!products || products.length === 0) {
        break; // No more products
      }

      // Fetch stock for this batch
      const productIds = products.map(p => p.id);
      const { data: stockData } = await supabase
        .from('stock_by_branch')
        .select('product_id, qty_available')
        .in('product_id', productIds)
        .gt('qty_available', 0); // Only positive stock interest us

      // Map stock
      const stockMap = new Map<number, number>();
      if (stockData) {
        for (const s of stockData) {
          const current = stockMap.get(s.product_id) ?? 0;
          stockMap.set(s.product_id, current + (s.qty_available ?? 0));
        }
      }

      // Filter and enrich
      for (const p of products) {
        const totalStock = stockMap.get(p.id) ?? 0;
        if (totalStock > 0) {
          accumulated.push({ ...p, total_stock: totalStock });
        }
        if (accumulated.length >= limit) break;
      }

      offset += batchSize;
    }

    res.json({ data: accumulated });
  } catch (err) {
    logger.error({ err }, 'Featured products error');
    res.status(500).json({ error: 'Failed to fetch featured products' });
  }
});

/**
 * GET /api/products/:id
 * Product detail with stock availability per branch
 */
router.get('/products/:id', async (req: Request, res: Response) => {
  try {
    const productId = parseInt(req.params.id as string);
    if (isNaN(productId)) {
      res.status(400).json({ error: 'Invalid product ID' });
      return;
    }

    // Fetch product + stock + category info
    const { data: product, error } = await supabase
      .from('products')
      .select('*')
      .eq('id', productId)
      .eq('is_published', true)
      .single();

    if (error || !product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Fetch stock by branch
    const { data: stockRaw, error: stockError } = await supabase
      .from('stock_by_branch')
      .select('qty_available, branch_id')
      .eq('product_id', productId)
      .gt('qty_available', 0);

    let stockData: any[] = [];
    let totalStock = 0;

    if (stockRaw && stockRaw.length > 0) {
      // Collect branch IDs
      const branchIds = stockRaw.map(s => s.branch_id);

      // Fetch branches
      const { data: branches } = await supabase
        .from('branches')
        .select('id, name, code, city, is_pickup_enabled')
        .in('id', branchIds);

      const branchMap = new Map<number, any>();
      if (branches) {
        for (const b of branches) {
          branchMap.set(b.id, b);
        }
      }

      // Merge
      stockData = stockRaw.map(s => ({
        qty_available: s.qty_available,
        branch: branchMap.get(s.branch_id) || null,
      })).filter(s => s.branch !== null); // Filter out if branch not found

      totalStock = stockData.reduce((sum, s) => sum + (s.qty_available ?? 0), 0);
    }

    // Fetch variant siblings if this product belongs to a variant group
    let variants: any[] = [];
    if (product.variant_group) {
      const { data: siblings } = await supabase
        .from('products')
        .select('id, variant_label, list_price, sale_price, total_stock, image_url, sort_weight_grams')
        .eq('variant_group', product.variant_group)
        .eq('is_published', true)
        .order('sort_weight_grams', { ascending: true });

      if (siblings && siblings.length > 1) {
        variants = siblings.map(s => ({
          id: s.id,
          variant_label: s.variant_label,
          list_price: s.list_price,
          sale_price: s.sale_price,
          total_stock: s.total_stock,
          image_url: s.image_url,
        }));
      }
    }

    res.json({
      ...product,
      stock_by_branch: stockData,
      total_stock: totalStock,
      variants,
    });
  } catch (err) {
    logger.error({ err }, 'Product detail error');
    res.status(500).json({ error: 'Failed to fetch product' });
  }
});

/**
 * GET /api/categories
 * Returns category tree
 * Query params: flat (true = flat list, default = tree structure)
 */
router.get('/categories', async (req: Request, res: Response) => {
  try {
    const flat = req.query.flat === 'true';

    const { data, error } = await supabase
      .from('categories')
      .select('*')
      .order('sort_order', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch categories' });
      return;
    }

    if (flat) {
      res.json({ data });
      return;
    }

    // Build tree structure
    const categoryMap = new Map<number, any>();
    const roots: any[] = [];

    for (const cat of data ?? []) {
      categoryMap.set(cat.id, { ...cat, children: [] });
    }

    for (const cat of data ?? []) {
      const node = categoryMap.get(cat.id)!;
      if (cat.parent_id && categoryMap.has(cat.parent_id)) {
        categoryMap.get(cat.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }

    res.json({ data: roots });
  } catch (err) {
    logger.error({ err }, 'Categories error');
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * GET /api/branches
 * List all store branches
 * Query: ?lat=9.0&lng=-79.5 → adds distance_km and sorts by nearest
 */
router.get('/branches', async (req: Request, res: Response) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);
  const hasCoords = !isNaN(lat) && !isNaN(lng);

  try {
    const { data, error } = await supabase
      .from('branches')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch branches' });
      return;
    }

    let branches = data ?? [];

    // Add distance and sort by nearest if coordinates provided
    if (hasCoords) {
      branches = branches.map((b) => {
        const bLat = b.latitude;
        const bLng = b.longitude;
        const distance_km = bLat && bLng ? haversineKm(lat, lng, bLat, bLng) : null;
        return { ...b, distance_km };
      });
      branches.sort((a, b) => {
        if (a.distance_km === null) return 1;
        if (b.distance_km === null) return -1;
        return a.distance_km - b.distance_km;
      });
    }

    res.json({ data: branches });
  } catch (err) {
    logger.error({ err }, 'Branches error');
    res.status(500).json({ error: 'Failed to fetch branches' });
  }
});

/**
 * GET /api/branches/:id
 * Get a single branch with full details
 */
router.get('/branches/:id', async (req: Request, res: Response) => {
  const branchId = req.params.id;

  try {
    const { data, error } = await supabase
      .from('branches')
      .select('*')
      .eq('id', branchId)
      .single();

    if (error || !data) {
      res.status(404).json({ error: 'Branch not found' });
      return;
    }

    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Branch detail error');
    res.status(500).json({ error: 'Failed to fetch branch' });
  }
});

/**
 * Haversine formula — distance in km between two lat/lng points
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

/**
 * Get all descendant category IDs for a given parent (recursive).
 */
async function getDescendantCategoryIds(parentId: number): Promise<number[]> {
  const { data } = await supabase
    .from('categories')
    .select('id, parent_id');

  if (!data) return [];

  const childrenMap = new Map<number, number[]>();
  for (const cat of data) {
    if (cat.parent_id != null) {
      const siblings = childrenMap.get(cat.parent_id) ?? [];
      siblings.push(cat.id);
      childrenMap.set(cat.parent_id, siblings);
    }
  }

  const result: number[] = [];
  const queue = [parentId];
  while (queue.length > 0) {
    const current = queue.pop()!;
    const children = childrenMap.get(current) ?? [];
    for (const childId of children) {
      result.push(childId);
      queue.push(childId);
    }
  }

  return result;
}

export default router;
