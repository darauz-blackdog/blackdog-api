import { z } from 'zod';

export const addCartItemSchema = z.object({
  product_id: z.number().int().positive(),
  quantity: z.number().int().min(1).max(99),
});

export const updateCartItemSchema = z.object({
  quantity: z.number().int().min(1).max(99),
});

export type AddCartItemInput = z.infer<typeof addCartItemSchema>;
export type UpdateCartItemInput = z.infer<typeof updateCartItemSchema>;
