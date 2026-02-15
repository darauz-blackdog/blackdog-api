import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  PORT: z.string().default('3002'),
  NODE_ENV: z.enum(['development', 'production']).default('development'),

  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  ODOO_URL: z.string().url(),
  ODOO_DB: z.string().min(1),
  ODOO_USERNAME: z.string().min(1),
  ODOO_PASSWORD: z.string().min(1),

  SYNC_PRODUCTS_INTERVAL: z.string().default('*/5 * * * *'),
  SYNC_CATEGORIES_INTERVAL: z.string().default('0 * * * *'),
  SYNC_STOCK_INTERVAL: z.string().default('*/5 * * * *'),

  // Tilopay
  TILOPAY_API_USER: z.string().default(''),
  TILOPAY_API_PASSWORD: z.string().default(''),
  TILOPAY_API_KEY: z.string().default(''),
  TILOPAY_API_BASE_URL: z.string().default('https://app.tilopay.com'),
  TILOPAY_REDIRECT_URL: z.string().default(''),

  // Yappy
  YAPPY_API_KEY: z.string().default(''),
  YAPPY_SECRET_KEY: z.string().default(''),
  YAPPY_API_BASE_URL: z.string().default('https://api.yappy.com.pa'),
  YAPPY_COLLECTION_ALIAS: z.string().default(''),
  YAPPY_GROUP_ID: z.string().default(''),
  YAPPY_DEVICE_ID: z.string().default(''),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
