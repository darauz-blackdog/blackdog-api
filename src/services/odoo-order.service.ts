import { searchRead, execute_kw, write } from '../config/odoo.js';
import { logger } from '../config/logger.js';

/**
 * Resolve product.template IDs → product.product (variant) IDs.
 * The app stores template IDs but sale.order.line needs variant IDs.
 */
export async function resolveVariantIds(
  templateIds: number[]
): Promise<Map<number, number>> {
  const variants = await searchRead<{ id: number; product_tmpl_id: [number, string] }>(
    'product.product',
    [['product_tmpl_id', 'in', templateIds]],
    ['id', 'product_tmpl_id'],
    { limit: templateIds.length * 2 }
  );

  const map = new Map<number, number>();
  for (const v of variants) {
    const tmplId = v.product_tmpl_id[0];
    if (!map.has(tmplId)) {
      map.set(tmplId, v.id);
    }
  }
  return map;
}

interface StockItem {
  product_id: number;
  quantity: number;
  product_name?: string;
}

interface StockIssue {
  product_id: number;
  product_name: string;
  requested: number;
  available: number;
}

interface StockCheckResult {
  ok: boolean;
  issues: StockIssue[];
}

/**
 * Check real-time stock in Odoo for a list of items at a specific warehouse.
 * Queries product.product qty_available filtered by warehouse context.
 */
export async function checkStockRealtime(
  items: StockItem[],
  warehouseId: number,
  variantMap: Map<number, number>
): Promise<StockCheckResult> {
  const variantIds = items
    .map(i => variantMap.get(i.product_id))
    .filter((id): id is number => id !== undefined);

  if (variantIds.length === 0) {
    return { ok: false, issues: [{ product_id: 0, product_name: 'Unknown', requested: 0, available: 0 }] };
  }

  // Query stock with warehouse context so qty_available reflects that warehouse only
  const stocks = await execute_kw<
    { id: number; qty_available: number }[]
  >(
    'product.product',
    'search_read',
    [[['id', 'in', variantIds]]],
    {
      fields: ['id', 'qty_available'],
      context: { warehouse: warehouseId },
    }
  );

  const stockMap = new Map<number, number>();
  for (const s of stocks) {
    stockMap.set(s.id, s.qty_available);
  }

  const issues: StockIssue[] = [];
  for (const item of items) {
    const variantId = variantMap.get(item.product_id);
    if (!variantId) {
      issues.push({
        product_id: item.product_id,
        product_name: item.product_name ?? 'Unknown',
        requested: item.quantity,
        available: 0,
      });
      continue;
    }

    const available = stockMap.get(variantId) ?? 0;
    if (available < item.quantity) {
      issues.push({
        product_id: item.product_id,
        product_name: item.product_name ?? 'Unknown',
        requested: item.quantity,
        available,
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Confirm a sale.order in Odoo (draft → sale).
 * This triggers stock.picking creation and reservation.
 */
export async function confirmSaleOrder(odooOrderId: number): Promise<void> {
  try {
    await execute_kw('sale.order', 'action_confirm', [[odooOrderId]]);
    logger.info({ odooOrderId }, 'Odoo sale.order confirmed (action_confirm)');
  } catch (err) {
    logger.error({ err, odooOrderId }, 'Failed to confirm Odoo sale.order');
    throw err;
  }
}

/**
 * Cancel a sale.order in Odoo and update fulfillment state.
 */
export async function cancelSaleOrder(odooOrderId: number): Promise<void> {
  try {
    await write('sale.order', [odooOrderId], {
      app_fulfillment_state: 'cancelled',
    });
    await execute_kw('sale.order', 'action_cancel', [[odooOrderId]]);
    logger.info({ odooOrderId }, 'Odoo sale.order cancelled');
  } catch (err) {
    logger.error({ err, odooOrderId }, 'Failed to cancel Odoo sale.order');
    throw err;
  }
}
