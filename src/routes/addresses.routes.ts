import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.use('/addresses', requireAuth);

/**
 * GET /api/addresses
 * List all addresses for the current user
 */
router.get('/addresses', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;

  try {
    const { data, error } = await supabase
      .from('addresses')
      .select('*')
      .eq('user_id', userId)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: false });

    if (error) {
      res.status(500).json({ error: 'Failed to fetch addresses' });
      return;
    }

    res.json({ data: data ?? [] });
  } catch (err) {
    logger.error({ err }, 'List addresses error');
    res.status(500).json({ error: 'Failed to fetch addresses' });
  }
});

/**
 * POST /api/addresses
 * Create a new address
 * Body: { label, address_line, city?, zone?, latitude?, longitude?, is_default? }
 */
router.post('/addresses', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { label, address_line, city, zone, latitude, longitude, is_default } = req.body;

  if (!address_line) {
    res.status(400).json({ error: 'address_line is required' });
    return;
  }

  try {
    // If setting as default, clear other defaults first
    if (is_default) {
      await supabase
        .from('addresses')
        .update({ is_default: false })
        .eq('user_id', userId)
        .eq('is_default', true);
    }

    const { data, error } = await supabase
      .from('addresses')
      .insert({
        user_id: userId,
        label: label ?? null,
        address_line,
        city: city ?? null,
        zone: zone ?? null,
        latitude: latitude ?? null,
        longitude: longitude ?? null,
        is_default: is_default ?? false,
      })
      .select()
      .single();

    if (error) {
      logger.error({ error }, 'Failed to create address');
      res.status(500).json({ error: 'Failed to create address' });
      return;
    }

    res.status(201).json(data);
  } catch (err) {
    logger.error({ err }, 'Create address error');
    res.status(500).json({ error: 'Failed to create address' });
  }
});

/**
 * PUT /api/addresses/:id
 * Update an address
 * Body: { label?, address_line?, city?, zone?, latitude?, longitude?, is_default? }
 */
router.put('/addresses/:id', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const addressId = req.params.id;
  const { label, address_line, city, zone, latitude, longitude, is_default } = req.body;

  try {
    // Verify ownership
    const { data: existing } = await supabase
      .from('addresses')
      .select('id')
      .eq('id', addressId)
      .eq('user_id', userId)
      .single();

    if (!existing) {
      res.status(404).json({ error: 'Address not found' });
      return;
    }

    // If setting as default, clear other defaults
    if (is_default) {
      await supabase
        .from('addresses')
        .update({ is_default: false })
        .eq('user_id', userId)
        .eq('is_default', true);
    }

    const updates: Record<string, unknown> = {};
    if (label !== undefined) updates.label = label;
    if (address_line !== undefined) updates.address_line = address_line;
    if (city !== undefined) updates.city = city;
    if (zone !== undefined) updates.zone = zone;
    if (latitude !== undefined) updates.latitude = latitude;
    if (longitude !== undefined) updates.longitude = longitude;
    if (is_default !== undefined) updates.is_default = is_default;

    const { data, error } = await supabase
      .from('addresses')
      .update(updates)
      .eq('id', addressId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update address' });
      return;
    }

    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Update address error');
    res.status(500).json({ error: 'Failed to update address' });
  }
});

/**
 * DELETE /api/addresses/:id
 * Delete an address
 */
router.delete('/addresses/:id', async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const addressId = req.params.id;

  try {
    const { error } = await supabase
      .from('addresses')
      .delete()
      .eq('id', addressId)
      .eq('user_id', userId);

    if (error) {
      res.status(500).json({ error: 'Failed to delete address' });
      return;
    }

    res.json({ message: 'Address deleted' });
  } catch (err) {
    logger.error({ err }, 'Delete address error');
    res.status(500).json({ error: 'Failed to delete address' });
  }
});

export default router;
