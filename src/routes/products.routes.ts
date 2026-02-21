import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';

const router = Router();

/**
 * GET /api/products
 * Paginated product list with optional category filter
 * Query params: category_id, page (1-based), limit, sort (name, price_asc, price_desc)
 */
router.get('/products', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
    const offset = (page - 1) * limit;
    const categoryId = req.query.category_id ? parseInt(req.query.category_id as string) : null;
    const sort = (req.query.sort as string) || 'name';

    let query = supabase
      .from('products')
      .select('*', { count: 'exact' })
      .eq('is_published', true);

    if (categoryId) {
      // Get all descendant category IDs for recursive filtering
      const descendantIds = await getDescendantCategoryIds(categoryId);
      query = query.in('category_id', [categoryId, ...descendantIds]);
    }

    // Sorting
    switch (sort) {
      case 'price_asc':
        query = query.order('list_price', { ascending: true });
        break;
      case 'price_desc':
        query = query.order('list_price', { ascending: false });
        break;
      case 'newest':
        query = query.order('synced_at', { ascending: false });
        break;
      default:
        query = query.order('name', { ascending: true });
    }

    query = query.range(offset, offset + limit - 1);

    const { data: products, error, count } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch products');
      res.status(500).json({ error: 'Failed to fetch products' });
      return;
    }

    if (!products || products.length === 0) {
      res.json({
        data: [],
        pagination: {
          page,
          limit,
          total: count ?? 0,
          total_pages: Math.ceil((count ?? 0) / limit),
        },
      });
      return;
    }

    // Manual join: Fetch stock for these products
    const productIds = products.map(p => p.id);
    const { data: stockData } = await supabase
      .from('stock_by_branch')
      .select('product_id, qty_available')
      .in('product_id', productIds);

    // Map stock by product_id
    const stockMap = new Map<number, number>();
    if (stockData) {
      for (const s of stockData) {
        const current = stockMap.get(s.product_id) ?? 0;
        stockMap.set(s.product_id, current + (s.qty_available ?? 0));
      }
    }

    // Enrich products
    const enrichedData = products.map(p => ({
      ...p,
      total_stock: stockMap.get(p.id) ?? 0,
    }));

    res.json({
      data: enrichedData,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / limit),
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

    const { data: products, error, count } = await supabase
      .from('products')
      .select('*', { count: 'exact' })
      .eq('is_published', true)
      .textSearch('name', tsQuery, { config: 'spanish' })
      .range(offset, offset + limit - 1);

    let finalProducts = products;
    let finalCount = count;

    if (error) {
      // Fallback to ILIKE if full-text search fails
      const { data: fallbackData, error: fallbackError, count: fallbackCount } = await supabase
        .from('products')
        .select('*', { count: 'exact' })
        .eq('is_published', true)
        .ilike('name', `%${q}%`)
        .order('name')
        .range(offset, offset + limit - 1);

      if (fallbackError) {
        res.status(500).json({ error: 'Search failed' });
        return;
      }
      finalProducts = fallbackData;
      finalCount = fallbackCount;
    }

    if (!finalProducts || finalProducts.length === 0) {
      res.json({
        data: [],
        pagination: {
          page,
          limit,
          total: finalCount ?? 0,
          total_pages: Math.ceil((finalCount ?? 0) / limit),
        },
      });
      return;
    }

    // Manual join: Fetch stock for these products
    const productIds = finalProducts.map(p => p.id);
    const { data: stockData } = await supabase
      .from('stock_by_branch')
      .select('product_id, qty_available')
      .in('product_id', productIds);

    // Map stock by product_id
    const stockMap = new Map<number, number>();
    if (stockData) {
      for (const s of stockData) {
        const current = stockMap.get(s.product_id) ?? 0;
        stockMap.set(s.product_id, current + (s.qty_available ?? 0));
      }
    }

    // Enrich products
    const enrichedData = finalProducts.map(p => ({
      ...p,
      total_stock: stockMap.get(p.id) ?? 0,
    }));

    res.json({
      data: enrichedData,
      pagination: {
        page,
        limit,
        total: finalCount ?? 0,
        total_pages: Math.ceil((finalCount ?? 0) / limit),
      },
    });
  } catch (err) {
    logger.error({ err }, 'Product search error');
    res.status(500).json({ error: 'Search failed' });
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

    res.json({
      ...product,
      stock_by_branch: stockData,
      total_stock: totalStock,
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
