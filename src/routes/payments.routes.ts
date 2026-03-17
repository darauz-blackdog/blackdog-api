import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { write } from '../config/odoo.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { createPaymentLink, getPaymentStatus, getSDKToken } from '../services/tilopay.service.js';
import { isYappyConfigured, findMatchingPayment, getPaymentInstructions } from '../services/yappy.service.js';
import { confirmSaleOrder } from '../services/odoo-order.service.js';

const router = Router();

/** Sync payment confirmation to Odoo: update fields + confirm the sale.order (best-effort, non-blocking) */
function syncPaymentToOdoo(odooOrderId: number | null | undefined) {
  if (!odooOrderId) return;
  (async () => {
    try {
      await write('sale.order', [odooOrderId], {
        app_fulfillment_state: 'confirmed',
        app_payment_status: 'paid',
      });
      await confirmSaleOrder(odooOrderId);
    } catch (err) {
      logger.warn({ err: (err as any)?.message, odooOrderId }, 'Failed to sync payment/confirm to Odoo (non-blocking)');
    }
  })();
}

/**
 * POST /api/payments/tilopay/create-link
 * Generate a Tilopay payment link for a pending_payment order
 * Body: { order_id }
 */
router.post('/payments/tilopay/create-link', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { order_id } = req.body;

  if (!order_id) {
    res.status(400).json({ error: 'order_id is required' });
    return;
  }

  try {
    // Get the order
    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', order_id)
      .eq('user_id', userId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    if (order.status !== 'pending_payment') {
      res.status(400).json({ error: `Order status is "${order.status}", expected "pending_payment"` });
      return;
    }

    if (order.payment_method !== 'tilopay') {
      res.status(400).json({ error: `Payment method is "${order.payment_method}", expected "tilopay"` });
      return;
    }

    // Get customer profile for name/email
    const { data: profile } = await supabase
      .from('customer_profiles')
      .select('first_name, last_name, email, phone')
      .eq('id', userId)
      .single();

    const customerName = profile
      ? `${profile.first_name ?? ''} ${profile.last_name ?? ''}`.trim() || 'Cliente'
      : 'Cliente';

    // Use Odoo order name if available, otherwise Supabase order ID prefix
    const orderNumber = order.odoo_order_name ?? `BDAPP-${order.id.slice(0, 8).toUpperCase()}`;

    const result = await createPaymentLink({
      orderNumber,
      amount: order.total,
      customerName,
      customerEmail: profile?.email ?? '',
      customerPhone: profile?.phone ?? '',
    });

    // Store the payment link and transaction ID on the order
    await supabase
      .from('orders')
      .update({
        payment_reference: result.tilopay_transaction_id,
        payment_link: result.payment_link,
        updated_at: new Date().toISOString(),
      })
      .eq('id', order_id);

    // Store payment link in Odoo
    if (order.odoo_order_id) {
      write('sale.order', [order.odoo_order_id], { app_payment_link: result.payment_link }).catch(() => {});
    }

    // Add tracking entry
    await supabase.from('order_tracking').insert({
      order_id,
      status: 'pending_payment',
      message: 'Link de pago Tilopay generado',
    });

    res.json({
      payment_link: result.payment_link,
      order_number: orderNumber,
    });
  } catch (err) {
    logger.error({ err, order_id }, 'Tilopay create-link error');
    res.status(500).json({ error: 'Failed to create payment link' });
  }
});

/**
 * POST /api/payments/sdk/init-tilopay
 * Generate SDK token for Tilopay SDK V2 embedded payment form.
 */
router.post('/payments/sdk/init-tilopay', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { order_id } = req.body;
  if (!order_id) { res.status(400).json({ error: 'order_id is required' }); return; }

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, total, status, payment_method, odoo_order_name, payment_reference')
      .eq('id', order_id)
      .eq('user_id', userId)
      .single();

    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    if (order.status !== 'pending_payment') {
      res.status(400).json({ error: `Order status is "${order.status}", expected "pending_payment"` }); return;
    }
    if (order.payment_method !== 'tilopay') {
      res.status(400).json({ error: `Payment method is "${order.payment_method}", expected "tilopay"` }); return;
    }

    const orderNumber = order.payment_reference ?? order.odoo_order_name ?? `BDAPP-${order.id.slice(0, 8).toUpperCase()}`;

    if (!order.payment_reference) {
      await supabase.from('orders').update({ payment_reference: orderNumber, updated_at: new Date().toISOString() }).eq('id', order_id);
    }

    const token = await getSDKToken();
    res.json({ token, order_number: orderNumber, amount: order.total, currency: 'USD' });
  } catch (err) {
    logger.error({ err, order_id }, 'Tilopay SDK init error');
    res.status(500).json({ error: 'Failed to initialize payment SDK' });
  }
});

/**
 * GET /api/payments/tilopay/return
 * Tilopay redirects here after the customer pays (or cancels)
 * Query params from Tilopay: code, description, auth, order, tpt, OrderHash, returnData
 *
 * code=1 means approved, anything else means failed.
 * We update the order status and redirect the user to a deep link or web page.
 */
router.get('/payments/tilopay/return', async (req: Request, res: Response) => {
  const { code, description, order: orderNumber, tpt, OrderHash, returnData } = req.query;

  logger.info({ code, orderNumber, tpt, description }, 'Tilopay payment return');

  try {
    const isApproved = String(code) === '1';

    // Find the order by payment_reference (which is the orderNumber we sent)
    let orderId: string | null = null;
    let odooOrderId: number | null = null;

    // Try returnData first (base64 encoded orderNumber)
    if (returnData) {
      try {
        const decoded = Buffer.from(String(returnData), 'base64').toString();
        const { data } = await supabase
          .from('orders')
          .select('id, odoo_order_id')
          .eq('payment_reference', decoded)
          .single();
        if (data) { orderId = data.id; odooOrderId = data.odoo_order_id; }
      } catch { /* ignore */ }
    }

    // Fallback: search by orderNumber
    if (!orderId && orderNumber) {
      const { data } = await supabase
        .from('orders')
        .select('id, odoo_order_id')
        .eq('payment_reference', String(orderNumber))
        .single();
      if (data) { orderId = data.id; odooOrderId = data.odoo_order_id; }
    }

    // Fallback: search by odoo_order_name
    if (!orderId && orderNumber) {
      const { data } = await supabase
        .from('orders')
        .select('id, odoo_order_id')
        .eq('odoo_order_name', String(orderNumber))
        .single();
      if (data) { orderId = data.id; odooOrderId = data.odoo_order_id; }
    }

    if (orderId) {
      if (isApproved) {
        // Update order to confirmed + paid
        await supabase
          .from('orders')
          .update({
            status: 'confirmed',
            payment_status: 'paid',
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId);

        await supabase.from('order_tracking').insert({
          order_id: orderId,
          status: 'confirmed',
          message: `Pago aprobado via Tilopay (auth: ${String(req.query.auth ?? 'N/A')})`,
        });

        syncPaymentToOdoo(odooOrderId);

        logger.info({ orderId, tpt }, 'Tilopay payment approved');
      } else {
        // Payment failed — keep as pending_payment
        await supabase
          .from('orders')
          .update({
            payment_status: 'failed',
            updated_at: new Date().toISOString(),
          })
          .eq('id', orderId);

        await supabase.from('order_tracking').insert({
          order_id: orderId,
          status: 'pending_payment',
          message: `Pago rechazado: ${String(description ?? 'sin detalle')}`,
        });

        logger.warn({ orderId, code, description }, 'Tilopay payment failed');
      }
    } else {
      logger.warn({ orderNumber, returnData }, 'Tilopay return: order not found');
    }

    // If from embedded SDK bridge, return JSON instead of HTML redirect
    if (req.query.source === 'sdk') {
      res.json({
        success: isApproved,
        order_id: orderId ?? '',
        message: isApproved ? 'Pago aprobado' : String(description ?? 'Pago no completado'),
      });
      return;
    }

    // Redirect to app deep link or fallback web page
    // The Flutter app will register a custom scheme: blackdogapp://payment-result?status=...
    const status = isApproved ? 'success' : 'failed';
    const deepLink = `blackdogapp://payment-result?status=${status}&order_id=${orderId ?? ''}`;

    // Send an HTML page that tries the deep link, then falls back to a message
    res.send(`<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>BlackDog - Pago</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { font-family: -apple-system, sans-serif; text-align: center; padding: 40px 20px; background: #1A1A2E; color: white; }
  h1 { color: #F7B104; }
  .btn { display: inline-block; margin-top: 20px; padding: 12px 32px; background: #F7B104; color: #1A1A2E; border-radius: 8px; text-decoration: none; font-weight: bold; }
</style></head>
<body>
  <h1>${isApproved ? 'Pago Exitoso' : 'Pago No Completado'}</h1>
  <p>${isApproved ? 'Tu pedido ha sido confirmado.' : 'El pago no se pudo completar. Puedes intentar de nuevo desde la app.'}</p>
  <a class="btn" href="${deepLink}">Volver a la App</a>
  <script>setTimeout(function(){ window.location.href = "${deepLink}"; }, 1500);</script>
</body></html>`);
  } catch (err) {
    logger.error({ err }, 'Tilopay return error');
    res.status(500).send('Error processing payment return');
  }
});

/**
 * POST /api/payments/tilopay/webhook
 * Optional webhook endpoint for Tilopay server-to-server notifications
 */
router.post('/payments/tilopay/webhook', async (req: Request, res: Response) => {
  const webhookData = req.body;
  logger.info({ webhookData }, 'Tilopay webhook received');

  try {
    const orderNumber = webhookData?.orderNumber ?? webhookData?.order ?? webhookData?.data?.orderNumber;

    if (!orderNumber) {
      res.json({ status: 'error', message: 'orderNumber not found' });
      return;
    }

    // Find the order
    const { data: order } = await supabase
      .from('orders')
      .select('id, status, payment_status, odoo_order_id')
      .or(`payment_reference.eq.${orderNumber},odoo_order_name.eq.${orderNumber}`)
      .single();

    if (!order) {
      logger.warn({ orderNumber }, 'Tilopay webhook: order not found');
      res.json({ status: 'error', message: 'order not found' });
      return;
    }

    // If already paid, skip
    if (order.payment_status === 'paid') {
      res.json({ status: 'ok', message: 'already paid' });
      return;
    }

    // Check status with Tilopay API
    const status = await getPaymentStatus(String(orderNumber));

    if (status && status.code === '1') {
      await supabase
        .from('orders')
        .update({
          status: 'confirmed',
          payment_status: 'paid',
          updated_at: new Date().toISOString(),
        })
        .eq('id', order.id);

      await supabase.from('order_tracking').insert({
        order_id: order.id,
        status: 'confirmed',
        message: 'Pago confirmado via webhook Tilopay',
      });

      syncPaymentToOdoo(order.odoo_order_id);
    }

    res.json({ status: 'success' });
  } catch (err) {
    logger.error({ err }, 'Tilopay webhook error');
    res.json({ status: 'error', message: 'internal error' });
  }
});

/**
 * GET /api/payments/tilopay/status/:order_id
 * Check payment status for an order (polls Tilopay API)
 */
router.get('/payments/tilopay/status/:order_id', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.order_id;

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, payment_reference, payment_status, status, odoo_order_id, odoo_order_name')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // If already resolved, return current status
    if (order.payment_status === 'paid') {
      res.json({ payment_status: 'paid', order_status: order.status });
      return;
    }

    // Query Tilopay
    const orderNumber = order.payment_reference ?? order.odoo_order_name;
    if (!orderNumber) {
      res.json({ payment_status: order.payment_status, order_status: order.status });
      return;
    }

    const tilopayStatus = await getPaymentStatus(orderNumber);

    if (tilopayStatus && tilopayStatus.code === '1') {
      // Payment approved — update order
      await supabase
        .from('orders')
        .update({
          status: 'confirmed',
          payment_status: 'paid',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      await supabase.from('order_tracking').insert({
        order_id: orderId,
        status: 'confirmed',
        message: 'Pago confirmado via consulta Tilopay',
      });

      syncPaymentToOdoo(order.odoo_order_id);

      res.json({ payment_status: 'paid', order_status: 'confirmed' });
    } else {
      res.json({ payment_status: order.payment_status, order_status: order.status });
    }
  } catch (err) {
    logger.error({ err }, 'Tilopay status check error');
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

/**
 * GET /api/payments/status/:order_id
 * Generic payment status — reads from Supabase, works for all payment methods.
 */
router.get('/payments/status/:order_id', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.order_id;
  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, payment_status, status')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();
    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    res.json({ payment_status: order.payment_status, order_status: order.status });
  } catch (err) {
    logger.error({ err }, 'Payment status check error');
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

// ================================================================
// YAPPY PAYMENT ENDPOINTS
// ================================================================

/**
 * GET /api/payments/yappy/instructions/:order_id
 * Get payment instructions for a Yappy order.
 * The app shows these so the customer knows how to pay via their Yappy app.
 */
router.get('/payments/yappy/instructions/:order_id', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.order_id;

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, total, payment_method, payment_reference, status, payment_status')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    if (order.payment_method !== 'yappy') {
      res.status(400).json({ error: 'Order payment method is not yappy' });
      return;
    }

    // Already paid
    if (order.payment_status === 'paid') {
      res.json({ payment_status: 'paid', order_status: order.status });
      return;
    }

    const instructions = getPaymentInstructions(
      order.payment_reference ?? String(orderId).slice(0, 8).toUpperCase(),
      order.total,
    );

    res.json({
      ...instructions,
      order_id: order.id,
      payment_status: order.payment_status,
      order_status: order.status,
    });
  } catch (err) {
    logger.error({ err }, 'Yappy instructions error');
    res.status(500).json({ error: 'Failed to get payment instructions' });
  }
});

/**
 * GET /api/payments/yappy/status/:order_id
 * Check if a Yappy payment has been received for this order.
 * Polls Yappy's movement history to match by amount + reference.
 */
router.get('/payments/yappy/status/:order_id', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.order_id;

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, total, payment_method, payment_reference, payment_status, status, odoo_order_id')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    // Already resolved
    if (order.payment_status === 'paid') {
      res.json({ payment_status: 'paid', order_status: order.status });
      return;
    }

    if (!isYappyConfigured()) {
      res.json({
        payment_status: order.payment_status,
        order_status: order.status,
        message: 'Yappy not configured yet — payment will be confirmed manually',
      });
      return;
    }

    // Search Yappy movement history for a matching payment
    const match = await findMatchingPayment(
      order.total,
      order.payment_reference ?? undefined,
    );

    if (match) {
      // Payment found — confirm order
      await supabase
        .from('orders')
        .update({
          status: 'confirmed',
          payment_status: 'paid',
          updated_at: new Date().toISOString(),
        })
        .eq('id', orderId);

      await supabase.from('order_tracking').insert({
        order_id: orderId,
        status: 'confirmed',
        message: `Pago Yappy detectado (${match.debitorName ?? 'cliente'}, tx: ${match.transactionId ?? 'N/A'})`,
      });

      syncPaymentToOdoo(order.odoo_order_id);

      logger.info(
        { orderId, yappyTx: match.transactionId, debitor: match.debitorName },
        'Yappy payment matched and confirmed',
      );

      res.json({ payment_status: 'paid', order_status: 'confirmed' });
    } else {
      res.json({
        payment_status: order.payment_status,
        order_status: order.status,
        message: 'Pago aún no detectado. Verifica que enviaste el monto exacto.',
      });
    }
  } catch (err) {
    logger.error({ err }, 'Yappy status check error');
    res.status(500).json({ error: 'Failed to check Yappy payment status' });
  }
});

/**
 * POST /api/payments/yappy/confirm-manual/:order_id
 * Manual confirmation endpoint (for admin/support use while Yappy API credentials are pending)
 * In production, this would be restricted to admin users.
 */
router.post('/payments/yappy/confirm-manual/:order_id', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const orderId = req.params.order_id;
  const { confirmation_note } = req.body;

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, payment_method, payment_status, status, odoo_order_id')
      .eq('id', orderId)
      .eq('user_id', userId)
      .single();

    if (!order) {
      res.status(404).json({ error: 'Order not found' });
      return;
    }

    if (order.payment_status === 'paid') {
      res.json({ message: 'Order already paid' });
      return;
    }

    if (order.status !== 'pending_payment') {
      res.status(400).json({ error: `Cannot confirm order in "${order.status}" status` });
      return;
    }

    await supabase
      .from('orders')
      .update({
        status: 'confirmed',
        payment_status: 'paid',
        updated_at: new Date().toISOString(),
      })
      .eq('id', orderId);

    await supabase.from('order_tracking').insert({
      order_id: orderId,
      status: 'confirmed',
      message: `Pago Yappy confirmado manualmente${confirmation_note ? ': ' + confirmation_note : ''}`,
    });

    syncPaymentToOdoo(order.odoo_order_id);

    res.json({ message: 'Order confirmed', order_status: 'confirmed', payment_status: 'paid' });
  } catch (err) {
    logger.error({ err }, 'Yappy manual confirm error');
    res.status(500).json({ error: 'Failed to confirm payment' });
  }
});

export default router;
