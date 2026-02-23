-- ============================================
-- BlackDog App — Supabase Schema
-- Run this in the Supabase SQL Editor
-- ============================================

-- App Categories (simplified categories for the mobile app)
CREATE TABLE IF NOT EXISTS app_categories (
  id serial PRIMARY KEY,
  name text NOT NULL UNIQUE,
  icon text NOT NULL,                       -- Material icon name
  sort_order int DEFAULT 0,
  created_at timestamptz DEFAULT now()
);

-- Products (cache from Odoo)
CREATE TABLE IF NOT EXISTS products (
  id bigint PRIMARY KEY,                    -- Odoo product.template ID
  name text NOT NULL,
  list_price numeric(10,2) NOT NULL DEFAULT 0,
  sale_price numeric(10,2),                 -- Discounted price (null = no discount)
  category_id bigint,
  category_name text,
  app_category_id int REFERENCES app_categories(id), -- Simplified app category
  brand text,                               -- Brand extracted from Odoo category path
  available_in_pos boolean DEFAULT false,    -- Available in Point of Sale
  product_type text,                        -- 'consu' or 'product'
  default_code text,                        -- SKU
  description text,
  image_url text,
  shopify_id bigint,                       -- Shopify product ID
  description_html text,                   -- Rich HTML description from Shopify
  tags text[] DEFAULT '{}',                -- Product tags from Shopify
  image_urls text[] DEFAULT '{}',          -- Array of CDN image URLs from Shopify
  handle text,                             -- Shopify URL handle
  is_published boolean DEFAULT true,
  odoo_updated_at timestamptz,
  synced_at timestamptz DEFAULT now()
);

CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_app_category ON products(app_category_id);
CREATE INDEX idx_products_brand ON products(brand);
CREATE INDEX idx_products_available_in_pos ON products(available_in_pos) WHERE available_in_pos = true;
CREATE INDEX idx_products_published ON products(is_published) WHERE is_published = true;
CREATE INDEX idx_products_name_search ON products USING gin(to_tsvector('spanish', name));
CREATE INDEX idx_products_shopify_id ON products(shopify_id);
CREATE INDEX idx_products_handle ON products(handle);

-- Categories (cache from Odoo)
CREATE TABLE IF NOT EXISTS categories (
  id bigint PRIMARY KEY,                    -- Odoo category ID
  name text NOT NULL,
  parent_id bigint REFERENCES categories(id),
  full_path text,
  icon text,
  sort_order int DEFAULT 0,
  synced_at timestamptz DEFAULT now()
);

-- Branches / Stores (cache from Odoo warehouses)
CREATE TABLE IF NOT EXISTS branches (
  id bigint PRIMARY KEY,                    -- Odoo warehouse ID
  name text NOT NULL,
  code text,
  address text,
  city text,
  phone text,
  email text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  opening_hours jsonb,
  is_pickup_enabled boolean DEFAULT true,
  is_delivery_enabled boolean DEFAULT true,
  synced_at timestamptz DEFAULT now()
);

-- Stock per branch (cache from Odoo stock.quant)
CREATE TABLE IF NOT EXISTS stock_by_branch (
  product_id bigint NOT NULL,
  branch_id bigint NOT NULL,
  qty_available numeric(10,2) DEFAULT 0,
  synced_at timestamptz DEFAULT now(),
  PRIMARY KEY (product_id, branch_id)
);

CREATE INDEX idx_stock_product ON stock_by_branch(product_id);
CREATE INDEX idx_stock_branch ON stock_by_branch(branch_id);

-- ============================================
-- User-generated data (not synced from Odoo)
-- ============================================

-- Customer profiles (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS customer_profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  odoo_partner_id bigint,                   -- res.partner ID in Odoo
  full_name text,
  phone text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Customer addresses
CREATE TABLE IF NOT EXISTS addresses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  label text,                               -- "Casa", "Oficina"
  address_line text NOT NULL,
  city text,
  zone text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  is_default boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_addresses_user ON addresses(user_id);

-- Shopping carts
CREATE TABLE IF NOT EXISTS carts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text DEFAULT 'active' CHECK (status IN ('active', 'converted', 'abandoned')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX idx_carts_active_user ON carts(user_id) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS cart_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cart_id uuid NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  product_id bigint NOT NULL,
  product_name text,
  product_price numeric(10,2),
  quantity int NOT NULL DEFAULT 1 CHECK (quantity > 0),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_cart_items_cart ON cart_items(cart_id);

-- Orders
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id),
  odoo_order_id bigint,                     -- sale.order ID in Odoo
  odoo_order_name text,                     -- "S00123"
  status text DEFAULT 'pending_payment' CHECK (status IN (
    'pending_payment', 'confirmed', 'preparing',
    'ready_pickup', 'shipping', 'delivered', 'cancelled'
  )),
  delivery_type text NOT NULL CHECK (delivery_type IN ('delivery', 'pickup')),
  branch_id bigint,                         -- Store for pickup or dispatch
  address_id uuid REFERENCES addresses(id),
  payment_method text CHECK (payment_method IN ('tilopay', 'yappy', 'in_store')),
  payment_status text DEFAULT 'pending' CHECK (payment_status IN (
    'pending', 'processing', 'paid', 'failed', 'refunded'
  )),
  payment_reference text,                    -- orderNumber sent to Tilopay
  payment_link text,                         -- Tilopay payment URL
  subtotal numeric(10,2) NOT NULL DEFAULT 0,
  delivery_fee numeric(10,2) DEFAULT 0,
  total numeric(10,2) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX idx_orders_user ON orders(user_id);
CREATE INDEX idx_orders_status ON orders(status);

-- Order items
CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id bigint NOT NULL,
  product_name text,
  quantity int NOT NULL,
  unit_price numeric(10,2) NOT NULL,
  total numeric(10,2) NOT NULL
);

CREATE INDEX idx_order_items_order ON order_items(order_id);

-- Order tracking timeline
CREATE TABLE IF NOT EXISTS order_tracking (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status text NOT NULL,
  message text,
  driver_name text,
  driver_phone text,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_tracking_order ON order_tracking(order_id);

-- Push notification tokens
CREATE TABLE IF NOT EXISTS push_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  platform text CHECK (platform IN ('ios', 'android')),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_push_tokens_user ON push_tokens(user_id);

-- Notification history
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title text NOT NULL,
  body text,
  type text DEFAULT 'order' CHECK (type IN ('order', 'promo', 'system')),
  reference_id text,
  is_read boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX idx_notifications_user ON notifications(user_id);
CREATE INDEX idx_notifications_unread ON notifications(user_id, is_read) WHERE is_read = false;

-- Sync logs
CREATE TABLE IF NOT EXISTS sync_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_name text NOT NULL,
  status text NOT NULL CHECK (status IN ('success', 'error')),
  records_synced int DEFAULT 0,
  duration_ms int,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz DEFAULT now()
);

CREATE INDEX idx_sync_logs_job ON sync_logs(job_name, finished_at DESC);

-- ============================================
-- Row Level Security (RLS)
-- ============================================

-- Public read access for products, categories, branches (cache data)
ALTER TABLE app_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "App categories are viewable by everyone" ON app_categories FOR SELECT USING (true);

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Products are viewable by everyone" ON products FOR SELECT USING (is_published = true);

ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Categories are viewable by everyone" ON categories FOR SELECT USING (true);

ALTER TABLE branches ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Branches are viewable by everyone" ON branches FOR SELECT USING (true);

ALTER TABLE stock_by_branch ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Stock is viewable by everyone" ON stock_by_branch FOR SELECT USING (true);

-- User-scoped data (users can only see their own)
ALTER TABLE customer_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own profile" ON customer_profiles FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON customer_profiles FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Users can insert own profile" ON customer_profiles FOR INSERT WITH CHECK (auth.uid() = id);

ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own addresses" ON addresses FOR ALL USING (auth.uid() = user_id);

ALTER TABLE carts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own cart" ON carts FOR ALL USING (auth.uid() = user_id);

ALTER TABLE cart_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own cart items" ON cart_items FOR ALL
  USING (cart_id IN (SELECT id FROM carts WHERE user_id = auth.uid()));

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own orders" ON orders FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own order items" ON order_items FOR SELECT
  USING (order_id IN (SELECT id FROM orders WHERE user_id = auth.uid()));

ALTER TABLE order_tracking ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own order tracking" ON order_tracking FOR SELECT
  USING (order_id IN (SELECT id FROM orders WHERE user_id = auth.uid()));

ALTER TABLE push_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own push tokens" ON push_tokens FOR ALL USING (auth.uid() = user_id);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own notifications" ON notifications FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can update own notifications" ON notifications FOR UPDATE USING (auth.uid() = user_id);

-- Sync logs: only service role can write, no public access
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
-- No public policy = only service_role key can access
