import { logger } from '../config/logger.js';
import { syncProducts } from './products.sync.js';
import { syncCategories } from './categories.sync.js';
import { syncStock } from './stock.sync.js';
import { syncBranches } from './branches.sync.js';

/**
 * Manual sync runner — use with: npm run sync
 * Runs all sync jobs once and exits.
 */
async function main() {
  logger.info('=== Manual sync started ===');

  try {
    const categories = await syncCategories();
    logger.info({ count: categories }, 'Categories synced');

    const branches = await syncBranches();
    logger.info({ count: branches }, 'Branches synced');

    const products = await syncProducts();
    logger.info({ count: products }, 'Products synced');

    const stock = await syncStock();
    logger.info({ count: stock }, 'Stock synced');

    logger.info('=== Manual sync completed ===');
  } catch (err) {
    logger.error({ err }, 'Manual sync failed');
    process.exit(1);
  }

  process.exit(0);
}

main();
