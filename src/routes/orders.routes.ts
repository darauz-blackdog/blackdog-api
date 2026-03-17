import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { create, searchRead, execute_kw, write } from '../config/odoo.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { createPaymentLink } from '../services/tilopay.service.js';
import { getPaymentInstructions } from '../services/yappy.service.js';
import { notifyOrderStatusChange } from '../services/push.service.js';
import { resolveVariantIds, checkStockRealtime, confirmSaleOrder, cancelSaleOrder } from '../services/odoo-order.service.js';

const router = Router();

router.use('/orders', requireAuth);

// Delivery fee removed — ASAP handles delivery and charges the customer directly.
// TODO: In the future, consider accepting delivery_type: 'asap' or a delivery_provider
// field to distinguish ASAP orders from legacy ones.
const DELIVERY_FEE_DEFAULT = 0;

// ── Cached Odoo IDs for BlackDog App module ──
let cachedUtmSourceId: number | null = null;
let cachedTeamId: number | null = null;

async function getAppUtmSourceId(): Promise<number | false> {
  if (cachedUtmSourceId) return cachedUtmSourceId;
  try {
    const sources = await searchRead<{ id: number }>(
      'utm.source',
      [['name', '=', 'BlackDog App']],
      ['id'],
      { limit: 1 }
    );
    cachedUtmSourceId = sources[0]?.id ?? null;
    return cachedUtmSourceId ?? false;
  } catch {
    return false;
  }
}

async function getAppTeamId(): Promise<number | false> {
  if (cachedTeamId) return cachedTeamId;
  try {
    const teams = await searchRead<{ id: number }>(
      'crm.team',
      [['name', '=', 'App Móvil']],
      ['id'],
      { limit: 1 }
    );
    cachedTeamId = teams[0]?.id ?? null;
    return cachedTeamId ?? false;
  } catch {
    return false;
  }
}

// Map backend payment_method → Odoo app_payment_method selection
const PAYMENT_METHOD_MAP: Record<string, string> = {
  tilopay: 'tilopay',
  yappy: 'yappy',
  in_store: 'cash',
};

// Map backend status → Odoo app_fulfillment_state
const FULFILLMENT_STATE_MAP: Record<string, string> = {
  pending_payment: 'awaiting_payment',
  confirmed: 'confirmed',
  preparing: 'preparing',
  ready_pickup: 'ready_pickup',
  shipping: 'shipping',
  delivered: 'delivered',
  cancelled: 'cancelled',
};

/**
 * POST /api/orders
 * Create a new order from the active cart
 * Body: { delivery_type, branch_id, address_id?, payment_method, notes? }
 */
router.post('/orders', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { delivery_type, branch_id, address_id, payment_method, notes } = req.body;

  logger.info({ body: req.body, userId }, 'POST /orders request received');

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

    // 2. Resolve variant IDs + validate stock (Odoo real-time → Supabase fallback)
    const templateIds = items.map(i => i.product_id);
    let variantMap = new Map<number, number>();
    let stockSource: 'odoo' | 'supabase' = 'supabase';

    try {
      variantMap = await resolveVariantIds(templateIds);

      const stockCheck = await checkStockRealtime(
        items.map(i => ({ product_id: i.product_id, quantity: i.quantity, product_name: i.product_name })),
        branch_id,
        variantMap
      );

      if (!stockCheck.ok) {
        const first = stockCheck.issues[0];
        res.status(400).json({
          error: `Insufficient stock for "${first.product_name}" at selected branch`,
          product_id: first.product_id,
          requested: first.requested,
          available: first.available,
          issues: stockCheck.issues,
        });
        return;
      }

      stockSource = 'odoo';
      logger.info({ branch_id, itemCount: items.length }, 'Stock validated via Odoo real-time');
    } catch (odooStockErr) {
      logger.warn({ err: odooStockErr }, 'Odoo stock check failed, falling back to Supabase');

      // Fallback: Supabase stock check
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
    }

    // 3. Calculate totals
    const subtotal = items.reduce(
      (sum, item) => sum + (item.product_price ?? 0) * item.quantity,
      0
    );
    const deliveryFee = delivery_type === 'delivery' ? DELIVERY_FEE_DEFAULT : 0;
    const total = Math.round((subtotal + deliveryFee) * 100) / 100;

    // 4. Get customer's Odoo partner ID + phone
    const { data: profile } = await supabase
      .from('customer_profiles')
      .select('odoo_partner_id, full_name, phone')
      .eq('id', userId)
      .single();

    // 5. Create sale.order in Odoo (best-effort)
    let odooOrderId: number | null = null;
    let odooOrderName: string | null = null;

    if (profile?.odoo_partner_id) {
      try {
        // Resolve variants if not done during stock check
        if (variantMap.size === 0) {
          variantMap = await resolveVariantIds(templateIds);
        }

        // Build order lines
        const orderLines = items.map(item => {
          const variantId = variantMap.get(item.product_id);
          return [0, 0, {
            product_id: variantId ?? false,
            product_uom_qty: item.quantity,
            price_unit: item.product_price ?? 0,
            name: item.product_name ?? 'Product',
          }];
        }).filter(line => (line[2] as any).product_id !== false);

        if (orderLines.length > 0) {
          // Resolve UTM source + sales team for app orders
          const [sourceId, teamId] = await Promise.all([
            getAppUtmSourceId(),
            getAppTeamId(),
          ]);

          const odooValues: Record<string, unknown> = {
            partner_id: profile.odoo_partner_id,
            order_line: orderLines,
            note: notes ?? '',
            warehouse_id: branch_id,
          };

          if (sourceId) odooValues.source_id = sourceId;
          if (teamId) odooValues.team_id = teamId;

          odooOrderId = await create('sale.order', odooValues);

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

          // Confirm immediately for in_store orders (triggers stock.picking)
          if (odooOrderId && payment_method === 'in_store') {
            try {
              await confirmSaleOrder(odooOrderId);
            } catch (confirmErr) {
              logger.warn({ err: confirmErr, odooOrderId }, 'Failed to confirm Odoo order for in_store (non-blocking)');
            }
          }

          logger.info({ odooOrderId, odooOrderName, stockSource }, 'Created Odoo sale.order');
        }
      } catch (odooErr) {
        logger.warn({ err: odooErr }, 'Failed to create Odoo sale.order (non-blocking)');
      }
    }

    // 6. Create order in Supabase
    const orderNumber = odooOrderName ?? `BDAPP-${Date.now().toString(36).toUpperCase()}`;

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
        payment_reference: orderNumber,
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

    // 6b. Log Supabase order ref (app_order_ref not on sale.order)
    if (odooOrderId) {
      logger.info({ odooOrderId, supabaseOrderId: order.id }, 'Linked Odoo sale.order to Supabase order');
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

    // Generate payment link for Tilopay
    if (payment_method === 'tilopay') {
      try {
        const customerEmail = (req as AuthenticatedRequest).user.email;
        const customerName = profile?.full_name ?? 'Cliente';

        const paymentResult = await createPaymentLink({
          orderNumber,
          amount: total,
          customerName,
          customerEmail,
          customerPhone: profile?.phone ?? '',
        });

        response.payment_url = paymentResult.payment_link;

        // Store payment link on the order
        await supabase
          .from('orders')
          .update({ payment_link: paymentResult.payment_link })
          .eq('id', order.id);

        logger.info({ orderId: order.id, paymentLink: paymentResult.payment_link }, 'Tilopay payment link generated');
      } catch (payErr) {
        logger.warn({ err: payErr }, 'Failed to generate Tilopay payment link (non-blocking)');
        response.payment_url = null;
        response.payment_message = 'Error generando link de pago. Intenta de nuevo desde tus pedidos.';
      }
    } else if (payment_method === 'yappy') {
      response.payment_url = null;
      response.yappy = getPaymentInstructions(orderNumber, total);
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
      .select('*, order_items(quantity)', { count: 'exact' })
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

    // Add item_count to each order and remove raw order_items
    const ordersWithCount = (data ?? []).map((order: any) => {
      const items = order.order_items ?? [];
      const item_count = items.reduce((sum: number, i: any) => sum + (i.quantity ?? 0), 0);
      const { order_items, ...rest } = order;
      return { ...rest, item_count };
    });

    res.json({
      data: ordersWithCount,
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

    // Send push notification
    notifyOrderStatusChange(userId, String(orderId), 'cancelled').catch(() => {});

    // Cancel in Odoo if exists
    if (order.odoo_order_id) {
      try {
        await cancelSaleOrder(order.odoo_order_id);
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

// ================================================================
// ADMIN / ODOO STATUS UPDATES
// ================================================================

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending_payment: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready_pickup', 'shipping', 'cancelled'],
  ready_pickup: ['delivered', 'cancelled'],
  shipping: ['delivered', 'cancelled'],
};

/**
 * POST /api/admin/orders/:id/status
 * Update order status (for Odoo webhooks or admin panel).
 * Authenticated via X-API-Key header matching SUPABASE_SERVICE_ROLE_KEY.
 *
 * Body: { status, message?, driver_name?, driver_phone? }
 */
router.post('/admin/orders/:id/status', async (req: Request, res: Response) => {
  // Authenticate via API key (service role key)
  const apiKey = req.headers['x-api-key'] as string;
  if (!apiKey || apiKey !== process.env.SUPABASE_SERVICE_ROLE_KEY) {
    res.status(401).json({ error: 'Invalid API key' });
    return;
  }

  const orderId = req.params.id;
  const { status: newStatus, message, driver_name, driver_phone } = req.body;

  if (!newStatus) {
    res.status(400).json({ error: 'status is required' });
    return;
  }

  try {
    // Get current order (use service role supabase — no RLS)
    const { data: order } = await supabase
      .from('orders')
      .select('id, user_id, status, odoo_order_id, odoo_order_name')
      .eq('id', orderId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // Validate transition
    const allowed = VALID_TRANSITIONS[order.status];
    if (!allowed || !allowed.includes(newStatus)) {
      res.status(400).json({
        error: `Invalid transition: "${order.status}" → "${newStatus}"`,
        allowed_transitions: allowed ?? [],
      });
      return;
    }

    // Update order status
    await supabase
      .from('orders')
      .update({ status: newStatus, updated_at: new Date().toISOString() })
      .eq('id', orderId);

    // Add tracking entry
    const defaultMessages: Record<string, string> = {
      confirmed: 'Pedido confirmado',
      preparing: 'Tu pedido está siendo preparado',
      ready_pickup: 'Tu pedido está listo para retirar',
      shipping: 'Tu pedido va en camino',
      delivered: 'Pedido entregado',
      cancelled: 'Pedido cancelado',
    };

    await supabase.from('order_tracking').insert({
      order_id: orderId,
      status: newStatus,
      message: message ?? defaultMessages[newStatus] ?? `Estado: ${newStatus}`,
      driver_name: driver_name ?? null,
      driver_phone: driver_phone ?? null,
    });

    // Send push notification to the customer
    notifyOrderStatusChange(order.user_id, String(orderId), newStatus, message).catch(() => {});

    // Note: fulfillment state lives on blackdog.app.order, not sale.order
    // TODO: Create/update blackdog.app.order when that integration is built

    logger.info({ orderId, oldStatus: order.status, newStatus }, 'Order status updated (admin)');

    res.json({
      message: 'Order status updated',
      order_id: orderId,
      old_status: order.status,
      new_status: newStatus,
    });
  } catch (err) {
    logger.error({ err }, 'Admin order status update error');
    res.status(500).json({ error: 'Failed to update order status' });
  }
});

export default router;
