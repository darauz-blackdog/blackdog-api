import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { createPaymentLink, getPaymentStatus } from '../services/tilopay.service.js';

const router = Router();

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

    // Try returnData first (base64 encoded orderNumber)
    if (returnData) {
      try {
        const decoded = Buffer.from(String(returnData), 'base64').toString();
        // decoded could be the orderNumber — find order by it
        const { data } = await supabase
          .from('orders')
          .select('id')
          .eq('payment_reference', decoded)
          .single();
        if (data) orderId = data.id;
      } catch { /* ignore */ }
    }

    // Fallback: search by orderNumber
    if (!orderId && orderNumber) {
      const { data } = await supabase
        .from('orders')
        .select('id')
        .eq('payment_reference', String(orderNumber))
        .single();
      if (data) orderId = data.id;
    }

    // Fallback: search by odoo_order_name
    if (!orderId && orderNumber) {
      const { data } = await supabase
        .from('orders')
        .select('id')
        .eq('odoo_order_name', String(orderNumber))
        .single();
      if (data) orderId = data.id;
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
      .select('id, status, payment_status')
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
      .select('id, payment_reference, payment_status, status, odoo_order_name')
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

      res.json({ payment_status: 'paid', order_status: 'confirmed' });
    } else {
      res.json({ payment_status: order.payment_status, order_status: order.status });
    }
  } catch (err) {
    logger.error({ err }, 'Tilopay status check error');
    res.status(500).json({ error: 'Failed to check payment status' });
  }
});

export default router;
