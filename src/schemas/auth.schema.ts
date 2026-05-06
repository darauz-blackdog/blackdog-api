import { z } from 'zod';

export const registerSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(128),
  full_name: z.string().min(1).max(120).optional(),
  phone: z.string().max(40).optional(),
  pet_types: z.array(z.string().max(40)).max(10).optional(),
});

export const completeProfileSchema = z.object({
  full_name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
});

export const updateProfileSchema = z.object({
  full_name: z.string().max(120).optional(),
  phone: z.string().max(40).optional(),
}).refine(d => d.full_name !== undefined || d.phone !== undefined, {
  message: 'At least one field required',
});
