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
      query = query.eq('category_id', categoryId);
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

    const { data, error, count } = await query;

    if (error) {
      logger.error({ error }, 'Failed to fetch products');
      res.status(500).json({ error: 'Failed to fetch products' });
      return;
    }

    res.json({
      data,
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

    const { data, error, count } = await supabase
      .from('products')
      .select('*', { count: 'exact' })
      .eq('is_published', true)
      .textSearch('name', tsQuery, { config: 'spanish' })
      .range(offset, offset + limit - 1);

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

      res.json({
        data: fallbackData,
        pagination: {
          page,
          limit,
          total: fallbackCount ?? 0,
          total_pages: Math.ceil((fallbackCount ?? 0) / limit),
        },
      });
      return;
    }

    res.json({
      data,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / limit),
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

    // Get products that have stock somewhere
    const { data, error } = await supabase
      .from('products')
      .select(`
        *,
        stock_by_branch!inner(qty_available)
      `)
      .eq('is_published', true)
      .gt('stock_by_branch.qty_available', 0)
      .order('list_price', { ascending: true })
      .limit(limit);

    if (error) {
      // Fallback: just get published products
      const { data: fallback, error: fbErr } = await supabase
        .from('products')
        .select('*')
        .eq('is_published', true)
        .order('synced_at', { ascending: false })
        .limit(limit);

      if (fbErr) {
        res.status(500).json({ error: 'Failed to fetch featured products' });
        return;
      }
      res.json({ data: fallback });
      return;
    }

    // Deduplicate (product may appear multiple times due to join)
    const seen = new Set<number>();
    const unique = data.filter(p => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    res.json({ data: unique });
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
    const productId = parseInt(req.params.id);
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

    // Fetch stock by branch with branch names
    const { data: stock } = await supabase
      .from('stock_by_branch')
      .select('qty_available, branch:branches(id, name, code, city, is_pickup_enabled)')
      .eq('product_id', productId)
      .gt('qty_available', 0);

    res.json({
      ...product,
      stock_by_branch: stock ?? [],
      total_stock: stock?.reduce((sum, s) => sum + (s.qty_available ?? 0), 0) ?? 0,
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
 */
router.get('/branches', async (req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('branches')
      .select('*')
      .order('name', { ascending: true });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch branches' });
      return;
    }

    res.json({ data });
  } catch (err) {
    logger.error({ err }, 'Branches error');
    res.status(500).json({ error: 'Failed to fetch branches' });
  }
});

export default router;
