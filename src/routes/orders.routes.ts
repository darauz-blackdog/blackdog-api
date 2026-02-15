import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { create, searchRead, execute_kw } from '../config/odoo.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.use('/orders', requireAuth);

const DELIVERY_FEE_DEFAULT = 3.50;

/**
 * POST /api/orders
 * Create a new order from the active cart
 * Body: { delivery_type, branch_id, address_id?, payment_method, notes? }
 */
router.post('/orders', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { delivery_type, branch_id, address_id, payment_method, notes } = req.body;

  // Validate required fields
  if (!delivery_type || !['delivery', 'pickup'].includes(delivery_type)) {
    res.status(400).json({ error: 'delivery_type must be "delivery" or "pickup"' });
    return;
  }
  if (!payment_method || !['tilopay', 'yappy', 'in_store'].includes(payment_method)) {
    res.status(400).json({ error: 'payment_method must be "tilopay", "yappy", or "in_store"' });
    return;
  }
  if (delivery_type === 'delivery' && !address_id) {
    res.status(400).json({ error: 'address_id is required for delivery orders' });
    return;
  }
  if (!branch_id) {
    res.status(400).json({ error: 'branch_id is required' });
    return;
  }

  try {
    // 1. Get active cart with items
    const { data: cart } = await supabase
      .from('carts')
      .select('id')
      .eq('user_id', userId)
      .eq('status', 'active')
      .single();

    if (!cart) {
      res.status(400).json({ error: 'No active cart found' });
      return;
    }

    const { data: items } = await supabase
      .from('cart_items')
      .select('*')
      .eq('cart_id', cart.id);

    if (!items || items.length === 0) {
      res.status(400).json({ error: 'Cart is empty' });
      return;
    }

    // 2. Validate stock for each item at the selected branch
    for (const item of items) {
      const { data: stock } = await supabase
        .from('stock_by_branch')
        .select('qty_available')
        .eq('product_id', item.product_id)
        .eq('branch_id', branch_id)
        .single();

      if (!stock || stock.qty_available < item.quantity) {
        res.status(400).json({
          error: `Insufficient stock for "${item.product_name}" at selected branch`,
          product_id: item.product_id,
          requested: item.quantity,
          available: stock?.qty_available ?? 0,
        });
        return;
      }
    }

    // 3. Calculate totals
    const subtotal = items.reduce(
      (sum, item) => sum + (item.product_price ?? 0) * item.quantity,
      0
    );
    const deliveryFee = delivery_type === 'delivery' ? DELIVERY_FEE_DEFAULT : 0;
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;

    // 4. Get customer's Odoo partner ID
    const { data: profile } = await supabase
      .from('customer_profiles')
      .select('odoo_partner_id')
      .eq('id', userId)
      .single();

    // 5. Create sale.order in Odoo (best-effort)
    let odooOrderId: number | null = null;
    let odooOrderName: string | null = null;

    if (profile?.odoo_partner_id) {
      try {
        // Get product.product IDs (variants) from product.template IDs
        const templateIds = items.map(i => i.product_id);
        const variants = await searchRead<{ id: number; product_tmpl_id: [number, string] }>(
          'product.product',
          [['product_tmpl_id', 'in', templateIds]],
          ['id', 'product_tmpl_id'],
          { limit: templateIds.length * 2 }
        );

        // Map template ID → first variant ID
        const templateToVariant = new Map<number, number>();
        for (const v of variants) {
          const tmplId = v.product_tmpl_id[0];
          if (!templateToVariant.has(tmplId)) {
            templateToVariant.set(tmplId, v.id);
          }
        }

        // Build order lines
        const orderLines = items.map(item => {
          const variantId = templateToVariant.get(item.product_id);
          return [0, 0, {
            product_id: variantId ?? false,
            product_uom_qty: item.quantity,
            price_unit: item.product_price ?? 0,
            name: item.product_name ?? 'Product',
          }];
        }).filter(line => (line[2] as any).product_id !== false);

        if (orderLines.length > 0) {
          odooOrderId = await create('sale.order', {
            partner_id: profile.odoo_partner_id,
            order_line: orderLines,
            note: `BlackDog App - ${delivery_type} - ${payment_method}${notes ? '\n' + notes : ''}`,
            warehouse_id: branch_id,
          });

          // Get the order name (S00XXX)
          if (odooOrderId) {
            const orders = await searchRead<{ name: string }>(
              'sale.order',
              [['id', '=', odooOrderId]],
              ['name'],
              { limit: 1 }
            );
            odooOrderName = orders[0]?.name ?? null;
          }

          logger.info({ odooOrderId, odooOrderName }, 'Created Odoo sale.order');
        }
      } catch (odooErr) {
        logger.warn({ err: odooErr }, 'Failed to create Odoo sale.order (non-blocking)');
      }
    }

    // 6. Create order in Supabase
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: userId,
        odoo_order_id: odooOrderId,
        odoo_order_name: odooOrderName,
        status: payment_method === 'in_store' ? 'confirmed' : 'pending_payment',
        delivery_type,
        branch_id,
        address_id: delivery_type === 'delivery' ? address_id : null,
        payment_method,
        payment_status: payment_method === 'in_store' ? 'pending' : 'pending',
        subtotal: Math.round(subtotal * 100) / 100,
        delivery_fee: deliveryFee,
        total,
        notes: notes ?? null,
      })
      .select()
      .single();

    if (orderError || !order) {
      logger.error({ error: orderError }, 'Failed to create order');
      res.status(500).json({ error: 'Failed to create order' });
      return;
    }

    // 7. Copy cart items to order_items
    const orderItems = items.map(item => ({
      order_id: order.id,
      product_id: item.product_id,
      product_name: item.product_name,
      quantity: item.quantity,
      unit_price: item.product_price ?? 0,
      total: Math.round((item.product_price ?? 0) * item.quantity * 100) / 100,
    }));

    await supabase.from('order_items').insert(orderItems);

    // 8. Add initial tracking entry
    await supabase.from('order_tracking').insert({
      order_id: order.id,
      status: order.status,
      message: payment_method === 'in_store'
        ? 'Pedido confirmado — pago en tienda al retirar'
        : 'Pedido creado — esperando pago',
    });

    // 9. Mark cart as converted
    await supabase.from('carts').update({ status: 'converted' }).eq('id', cart.id);

    // 10. Return order with payment URL if applicable
    const response: Record<string, unknown> = {
      order,
      odoo_order_name: odooOrderName,
      items: orderItems,
    };

    // TODO: Generate payment URLs for Tilopay/Yappy when integrated
    if (payment_method === 'tilopay') {
      response.payment_url = null; // Will be populated when Tilopay is integrated
      response.payment_message = 'Tilopay integration pending — use in_store for now';
    } else if (payment_method === 'yappy') {
      response.payment_url = null;
      response.payment_message = 'Yappy integration pending — use in_store for now';
    }

    res.status(201).json(response);
  } catch (err) {
    logger.error({ err }, 'Create order error');
    res.status(500).json({ error: 'Failed to create order' });
  }
});

/**
 * GET /api/orders
 * List user's orders
 * Query: ?status=confirmed&page=1&limit=10
 */
router.get('/orders', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 10));
  const offset = (page - 1) * limit;
  const status = req.query.status as string | undefined;

  try {
    let query = supabase
      .from('orders')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error, count } = await query;

    if (error) {
      res.status(500).json({ error: 'Failed to fetch orders' });
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
    logger.error({ err }, 'List orders error');
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * GET /api/orders/:id
 * Get order detail with items and tracking
 */
router.get('/orders/:id', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.id;

  try {
    const { data: order, error } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (error || !order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // Get items and tracking in parallel
    const [itemsResult, trackingResult, branchResult] = await Promise.all([
      supabase.from('order_items').select('*').eq('order_id', orderId),
      supabase.from('order_tracking').select('*').eq('order_id', orderId).order('created_at', { ascending: true }),
      order.branch_id
        ? supabase.from('branches').select('id, name, code, address, phone').eq('id', order.branch_id).single()
        : Promise.resolve({ data: null }),
    ]);

    res.json({
      ...order,
      items: itemsResult.data ?? [],
      tracking: trackingResult.data ?? [],
      branch: branchResult.data,
    });
  } catch (err) {
    logger.error({ err }, 'Order detail error');
    res.status(500).json({ error: 'Failed to fetch order' });
  }
});

/**
 * POST /api/orders/:id/cancel
 * Cancel an order (only if pending_payment or confirmed)
 */
router.post('/orders/:id/cancel', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.id;

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    if (!['pending_payment', 'confirmed'].includes(order.status)) {
      res.status(400).json({ error: `Cannot cancel order in "${order.status}" status` });
      return;
    }

    // Update order status
    await supabase
      .from('orders')
      .update({ status: 'cancelled', updated_at: new Date().toISOString() })
      .eq('id', orderId);

    // Add tracking entry
    await supabase.from('order_tracking').insert({
      order_id: orderId,
      status: 'cancelled',
      message: 'Pedido cancelado por el cliente',
    });

    // Cancel in Odoo if exists
    if (order.odoo_order_id) {
      try {
        await execute_kw('sale.order', 'action_cancel', [[order.odoo_order_id]]);
        logger.info({ odooOrderId: order.odoo_order_id }, 'Cancelled Odoo sale.order');
      } catch (odooErr) {
        logger.warn({ err: odooErr }, 'Failed to cancel Odoo order (non-blocking)');
      }
    }

    res.json({ message: 'Order cancelled' });
  } catch (err) {
    logger.error({ err }, 'Cancel order error');
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});

export default router;
