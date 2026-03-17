import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { createYappyOrder, verifyIPNHash, isYappyV2Configured } from '../services/yappy-v2.service.js';

const router = Router();

router.post('/payments/yappy-v2/create-order', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { order_id, phone } = req.body;

  if (!order_id || !phone) { res.status(400).json({ error: 'order_id and phone are required' }); return; }
  if (!isYappyV2Configured()) { res.status(503).json({ error: 'Yappy V2 not configured' }); return; }

  try {
    const { data: order } = await supabase
      .from('orders')
      .select('id, total, subtotal, delivery_fee, status, payment_method, odoo_order_name')
      .eq('id', order_id).eq('user_id', userId).single();

    if (!order) { res.status(404).json({ error: 'Order not found' }); return; }
    if (order.status !== 'pending_payment') {
      res.status(400).json({ error: `Order status is "${order.status}", expected "pending_payment"` }); return;
    }
    if (order.payment_method !== 'yappy') {
      res.status(400).json({ error: `Payment method is "${order.payment_method}", expected "yappy"` }); return;
    }

    const yappyRef = order.odoo_order_name ?? `BD-${order.id.slice(0, 11).toUpperCase()}`;
    const result = await createYappyOrder({
      orderId: yappyRef, phone, subtotal: order.subtotal, taxes: 0, discount: 0, total: order.total,
    });

    await supabase.from('orders').update({ payment_reference: yappyRef, updated_at: new Date().toISOString() }).eq('id', order_id);
    await supabase.from('order_tracking').insert({ order_id, status: 'pending_payment', message: `Orden Yappy V2 creada (ref: ${yappyRef})` });

    res.json(result);
  } catch (err) {
    logger.error({ err, order_id }, 'Yappy V2 create-order error');
    res.status(500).json({ error: 'Failed to create Yappy order' });
  }
});

router.get('/payments/yappy-v2/ipn', async (req: Request, res: Response) => {
  const { orderId, Hash, status, domain } = req.query;
  logger.info({ orderId, status, domain }, 'Yappy V2 IPN received');

  if (!orderId || !Hash || !status) { res.status(400).send('Missing required params'); return; }

  try {
    const isValid = verifyIPNHash({
      orderId: String(orderId), status: String(status), domain: String(domain ?? ''), hash: String(Hash),
    });
    if (!isValid) { logger.warn({ orderId, status }, 'Yappy V2 IPN: invalid hash'); res.status(403).send('Invalid hash'); return; }

    const { data: order } = await supabase.from('orders').select('id, payment_status, status').eq('payment_reference', String(orderId)).single();
    if (!order) { res.status(200).send('OK'); return; }
    if (order.payment_status === 'paid') { res.status(200).send('OK'); return; }

    const yappyStatus = String(status);
    if (yappyStatus === 'E') {
      await supabase.from('orders').update({ status: 'confirmed', payment_status: 'paid', updated_at: new Date().toISOString() }).eq('id', order.id);
      await supabase.from('order_tracking').insert({ order_id: order.id, status: 'confirmed', message: 'Pago confirmado via Yappy IPN' });
      logger.info({ orderId: order.id }, 'Yappy V2 IPN: payment confirmed');
    } else {
      const statusMap: Record<string, string> = { R: 'failed', C: 'cancelled', X: 'failed' };
      const messageMap: Record<string, string> = {
        R: 'Pago Yappy rechazado', C: 'Pago Yappy cancelado por el cliente', X: 'Pago Yappy expirado',
      };
      await supabase.from('orders').update({ payment_status: statusMap[yappyStatus] ?? 'failed', updated_at: new Date().toISOString() }).eq('id', order.id);
      await supabase.from('order_tracking').insert({ order_id: order.id, status: 'pending_payment', message: messageMap[yappyStatus] ?? `Yappy IPN: ${yappyStatus}` });
    }

    res.status(200).send('OK');
  } catch (err) {
    logger.error({ err }, 'Yappy V2 IPN error');
    res.status(200).send('OK');
  }
});

export default router;
