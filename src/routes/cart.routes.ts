import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

// All cart routes require auth
router.use('/cart', requireAuth);

/**
 * GET /api/cart
 * Get active cart with items for current user
 */
router.get('/cart', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;

  try {
    // Get or create active cart
    let { data: cart } = await supabase
      .from('carts')
      .select('*')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!cart) {
      const { data: newCart, error } = await supabase
        .from('carts')
        .insert({ user_id: userId, status: 'active' })
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: 'Failed to create cart' });
        return;
      }
      cart = newCart;
    }

    // Get cart items with product info
    const { data: items } = await supabase
      .from('cart_items')
      .select('*')
      .eq('cart_id', cart.id)
      .order('created_at', { ascending: true });

    const cartItems = items ?? [];
    const subtotal = cartItems.reduce(
      (sum, item) => sum + (item.product_price ?? 0) * item.quantity,
      0
    );

    res.json({
      cart: {
        id: cart.id,
        status: cart.status,
        created_at: cart.created_at,
      },
      items: cartItems,
      item_count: cartItems.reduce((sum, item) => sum + item.quantity, 0),
      subtotal: Math.round(subtotal * 100) / 100,
    });
  } catch (err) {
    logger.error({ err }, 'Get cart error');
    res.status(500).json({ error: 'Failed to fetch cart' });
  }
});

/**
 * POST /api/cart/items
 * Add item to cart (or update quantity if already exists)
 * Body: { product_id, quantity }
 */
router.post('/cart/items', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { product_id, quantity = 1 } = req.body;

  if (!product_id || quantity < 1) {
    res.status(400).json({ error: 'product_id and quantity (>= 1) are required' });
    return;
  }

  try {
    // Verify product exists and get price
    const { data: product } = await supabase
      .from('products')
      .select('id, name, list_price, sale_price, is_published')
      .eq('id', product_id)
      .eq('is_published', true)
      .single();

    if (!product) {
      res.status(404).json({ error: 'Product not found' });
      return;
    }

    // Check stock availability
    const { data: stock } = await supabase
      .from('stock_by_branch')
      .select('qty_available')
      .eq('product_id', product_id)
      .gt('qty_available', 0);

    const totalStock = stock?.reduce((sum, s) => sum + (s.qty_available ?? 0), 0) ?? 0;
    if (totalStock < quantity) {
      res.status(400).json({
        error: 'Insufficient stock',
        available: totalStock,
      });
      return;
    }

    // Get or create active cart
    let { data: cart } = await supabase
      .from('carts')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!cart) {
      const { data: newCart } = await supabase
        .from('carts')
        .insert({ user_id: userId, status: 'active' })
        .select('id')
        .single();
      cart = newCart;
    }

    if (!cart) {
      res.status(500).json({ error: 'Failed to get cart' });
      return;
    }

    // Check if item already in cart
    const { data: existing } = await supabase
      .from('cart_items')
      .select('id, quantity')
      .eq('cart_id', cart.id)
      .eq('product_id', product_id)
      .single();

    const effectivePrice = product.sale_price ?? product.list_price;

    if (existing) {
      // Update quantity
      const newQty = existing.quantity + quantity;
      const { data: updated, error } = await supabase
        .from('cart_items')
        .update({
          quantity: newQty,
          product_price: effectivePrice,
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: 'Failed to update cart item' });
        return;
      }
      res.json(updated);
    } else {
      // Insert new item
      const { data: item, error } = await supabase
        .from('cart_items')
        .insert({
          cart_id: cart.id,
          product_id: product.id,
          product_name: product.name,
          product_price: effectivePrice,
          quantity,
        })
        .select()
        .single();

      if (error) {
        res.status(500).json({ error: 'Failed to add item to cart' });
        return;
      }
      res.status(201).json(item);
    }
  } catch (err) {
    logger.error({ err }, 'Add to cart error');
    res.status(500).json({ error: 'Failed to add item to cart' });
  }
});

/**
 * PUT /api/cart/items/:id
 * Update cart item quantity
 * Body: { quantity }
 */
router.put('/cart/items/:id', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const itemId = req.params.id;
  const { quantity } = req.body;

  if (!quantity || quantity < 1) {
    res.status(400).json({ error: 'quantity (>= 1) is required' });
    return;
  }

  try {
    // Verify item belongs to user's active cart
    const { data: item } = await supabase
      .from('cart_items')
      .select('id, product_id, cart_id, cart:carts!inner(user_id, status)')
      .eq('id', itemId)
      .single();

    if (!item || (item as any).cart?.user_id !== userId || (item as any).cart?.status !== 'active') {
      res.status(404).json({ error: 'Cart item not found' });
      return;
    }

    // Check stock
    const { data: stock } = await supabase
      .from('stock_by_branch')
      .select('qty_available')
      .eq('product_id', item.product_id)
      .gt('qty_available', 0);

    const totalStock = stock?.reduce((sum, s) => sum + (s.qty_available ?? 0), 0) ?? 0;
    if (totalStock < quantity) {
      res.status(400).json({ error: 'Insufficient stock', available: totalStock });
      return;
    }

    const { data: updated, error } = await supabase
      .from('cart_items')
      .update({ quantity })
      .eq('id', itemId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update cart item' });
      return;
    }
    res.json(updated);
  } catch (err) {
    logger.error({ err }, 'Update cart item error');
    res.status(500).json({ error: 'Failed to update cart item' });
  }
});

/**
 * DELETE /api/cart/items/:id
 * Remove item from cart
 */
router.delete('/cart/items/:id', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const itemId = req.params.id;

  try {
    // Verify item belongs to user's active cart
    const { data: item } = await supabase
      .from('cart_items')
      .select('id, cart:carts!inner(user_id, status)')
      .eq('id', itemId)
      .single();

    if (!item || (item as any).cart?.user_id !== userId || (item as any).cart?.status !== 'active') {
      res.status(404).json({ error: 'Cart item not found' });
      return;
    }

    const { error } = await supabase
      .from('cart_items')
      .delete()
      .eq('id', itemId);

    if (error) {
      res.status(500).json({ error: 'Failed to remove cart item' });
      return;
    }
    res.json({ message: 'Item removed' });
  } catch (err) {
    logger.error({ err }, 'Remove cart item error');
    res.status(500).json({ error: 'Failed to remove cart item' });
  }
});

/**
 * DELETE /api/cart
 * Clear all items from active cart
 */
router.delete('/cart', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;

  try {
    const { data: cart } = await supabase
      .from('carts')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!cart) {
      res.json({ message: 'Cart already empty' });
      return;
    }

    await supabase.from('cart_items').delete().eq('cart_id', cart.id);

    res.json({ message: 'Cart cleared' });
  } catch (err) {
    logger.error({ err }, 'Clear cart error');
    res.status(500).json({ error: 'Failed to clear cart' });
  }
});

export default router;
