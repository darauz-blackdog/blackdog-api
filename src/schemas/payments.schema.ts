import { z } from 'zod';

const orderIdSchema = z.string().uuid();

export const initPaymentSchema = z.object({
  order_id: orderIdSchema,
});

// Panama mobile phones: 8 digits, optionally with country code
const phoneSchema = z.string().regex(
  /^(\+?507)?[\s-]?\d{4}[\s-]?\d{4}$/,
  'Invalid Panama phone number'
);

export const yappyCreateOrderSchema = z.object({
  order_id: orderIdSchema,
  phone: phoneSchema,
});

export const yappyCreateSchema = z.object({
  order_id: orderIdSchema,
  phone: phoneSchema,
});

export type InitPaymentInput = z.infer<typeof initPaymentSchema>;
export type YappyCreateOrderInput = z.infer<typeof yappyCreateOrderSchema>;
