import cron from 'node-cron';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { syncProducts } from './products.sync.js';
import { syncCategories } from './categories.sync.js';
import { syncStock } from './stock.sync.js';
import { syncBranches } from './branches.sync.js';

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

  // Run initial sync on startup
  runInitialSync();
}

async function runInitialSync() {
  logger.info('Running initial sync on startup...');
  try {
    await syncCategories();
    await syncBranches();
    await syncProducts();
    await syncStock();
    logger.info('Initial sync completed');
  } catch (err) {
    logger.error({ err }, 'Initial sync failed — will retry on next cron cycle');
  }
}
