import { z } from 'zod';

export const createOrderSchema = z.object({
  delivery_type: z.enum(['pickup', 'delivery']).optional(),
  branch_id: z.number().int().positive(),
  payment_method: z.enum(['tilopay', 'yappy', 'in_store']),
  address_id: z.string().uuid().optional().nullable(),
  notes: z.string().max(500).optional(),
});

export const adminOrderStatusSchema = z.object({
  status: z.enum([
    'pending_payment', 'confirmed', 'preparing',
    'ready_pickup', 'shipping', 'delivered', 'cancelled',
  ]),
  message: z.string().max(500).optional(),
  driver_name: z.string().max(120).optional(),
  driver_phone: z.string().max(40).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type AdminOrderStatusInput = z.infer<typeof adminOrderStatusSchema>;
