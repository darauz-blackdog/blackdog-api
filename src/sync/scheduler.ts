import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { syncProducts, syncProductsFull } from './products.sync.js';
import { syncCategories } from './categories.sync.js';
import { syncStock } from './stock.sync.js';
import { syncBranches } from './branches.sync.js';
import { syncShopify } from './shopify.sync.js';

export function startSyncJobs() {
  logger.info('Starting sync jobs...');

  // Products: every 5 minutes
  cron.schedule(env.SYNC_PRODUCTS_INTERVAL, async () => {
    logger.info('Running product sync...');
    try {
      const count = await syncProducts();
      logger.info({ count }, 'Product sync completed');
    } catch (err) {
      logger.error({ err }, 'Product sync failed');
    }
  });

  // Categories: every hour
  cron.schedule(env.SYNC_CATEGORIES_INTERVAL, async () => {
    logger.info('Running category sync...');
    try {
      const count = await syncCategories();
      logger.info({ count }, 'Category sync completed');
    } catch (err) {
      logger.error({ err }, 'Category sync failed');
    }
  });

  // Stock: every 5 minutes
  cron.schedule(env.SYNC_STOCK_INTERVAL, async () => {
    logger.info('Running stock sync...');
    try {
      const count = await syncStock();
      logger.info({ count }, 'Stock sync completed');
    } catch (err) {
      logger.error({ err }, 'Stock sync failed');
    }
  });

  // Branches: daily at 3am
  cron.schedule('0 3 * * *', async () => {
    logger.info('Running branch sync...');
    try {
      const count = await syncBranches();
      logger.info({ count }, 'Branch sync completed');
    } catch (err) {
      logger.error({ err }, 'Branch sync failed');
    }
  });

  // Shopify enrichment: daily at 4am (images/descriptions don't change often)
  cron.schedule('0 4 * * *', async () => {
    logger.info('Running Shopify sync...');
    try {
      const count = await syncShopify();
      logger.info({ count }, 'Shopify sync completed');
    } catch (err) {
      logger.error({ err }, 'Shopify sync failed');
    }
  });

  // Run initial sync on startup
  runInitialSync();
}

async function runInitialSync() {
  logger.info('Running initial sync on startup...');
  try {
    await syncCategories();
    await syncBranches();
    // Full product sync on startup (all 3800+ products from Odoo)
    await syncProductsFull();
    await syncStock();
    // Shopify enrichment (runs after products are in DB)
    await syncShopify();
    logger.info('Initial sync completed');
  } catch (err) {
    logger.error({ err }, 'Initial sync failed — will retry on next cron cycle');
  }
}
