import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { create, write as odooWrite } from '../config/odoo.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { authLimiter } from '../middleware/rate-limit.js';

const router = Router();

/**
 * POST /api/auth/register
 * Register a new user with email/password via Supabase Auth,
 * create customer_profile and Odoo res.partner.
 */
router.post('/auth/register', authLimiter, async (req: Request, res: Response) => {
  const { email, password, full_name, phone } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  try {
    // 1. Create Supabase auth user
    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name, phone },
    });

    if (authError) {
      logger.warn({ error: authError.message }, 'Supabase registration failed');
      res.status(400).json({ error: authError.message });
      return;
    }

    const userId = authData.user.id;

    // 2. Create Odoo res.partner (best-effort, don't block registration)
    let odooPartnerId: number | null = null;
    try {
      odooPartnerId = await create('res.partner', {
        name: full_name || email,
        email,
        phone: phone || false,
        customer_rank: 1,
        comment: 'Created from BlackDog App',
      });
      logger.info({ odooPartnerId, email }, 'Created Odoo partner');
    } catch (odooErr) {
      logger.warn({ err: odooErr, email }, 'Failed to create Odoo partner (non-blocking)');
    }

    // 3. Create customer_profile
    const { error: profileError } = await supabase.from('customer_profiles').insert({
      id: userId,
      odoo_partner_id: odooPartnerId,
      full_name: full_name || null,
      phone: phone || null,
    });

    if (profileError) {
      logger.warn({ error: profileError, userId }, 'Failed to create customer profile');
    }

    res.status(201).json({
      user: {
        id: userId,
        email: authData.user.email,
        full_name,
      },
      odoo_partner_id: odooPartnerId,
    });
  } catch (err) {
    logger.error({ err }, 'Registration error');
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * POST /api/auth/complete-profile
 * Called after social login (Google/Apple) to create profile + Odoo partner.
 * Requires auth token.
 */
router.post('/auth/complete-profile', requireAuth, async (req: Request, res: Response) => {
  const { id: userId, email } = (req as AuthenticatedRequest).user;
  const { full_name, phone } = req.body;

  try {
    // Check if profile already exists
    const { data: existing } = await supabase
      .from('customer_profiles')
      .select('id, odoo_partner_id')
      .eq('id', userId)
      .single();

    if (existing) {
      // Update existing profile
      const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
      if (full_name) updates.full_name = full_name;
      if (phone) updates.phone = phone;

      await supabase.from('customer_profiles').update(updates).eq('id', userId);
      res.json({ message: 'Profile updated', odoo_partner_id: existing.odoo_partner_id });
      return;
    }

    // Create Odoo partner (best-effort)
    let odooPartnerId: number | null = null;
    try {
      odooPartnerId = await create('res.partner', {
        name: full_name || email,
        email,
        phone: phone || false,
        customer_rank: 1,
        comment: 'Created from BlackDog App (social login)',
      });
    } catch (odooErr) {
      logger.warn({ err: odooErr, email }, 'Failed to create Odoo partner');
    }

    // Create profile
    const { error } = await supabase.from('customer_profiles').insert({
      id: userId,
      odoo_partner_id: odooPartnerId,
      full_name: full_name || null,
      phone: phone || null,
    });

    if (error) {
      logger.warn({ error, userId }, 'Failed to create customer profile');
      res.status(500).json({ error: 'Failed to create profile' });
      return;
    }

    res.status(201).json({
      message: 'Profile created',
      odoo_partner_id: odooPartnerId,
    });
  } catch (err) {
    logger.error({ err }, 'Complete profile error');
    res.status(500).json({ error: 'Failed to complete profile' });
  }
});

/**
 * GET /api/auth/profile
 * Get current user's profile
 */
router.get('/auth/profile', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;

  try {
    const { data: profile, error } = await supabase
      .from('customer_profiles')
      .select('*')
      .eq('id', userId)
      .single();

    if (error || !profile) {
      res.status(404).json({ error: 'Profile not found' });
      return;
    }

    const { data: addresses } = await supabase
      .from('addresses')
      .select('*')
      .eq('user_id', userId);

    res.json({ ...profile, addresses: addresses ?? [] });
  } catch (err) {
    logger.error({ err }, 'Get profile error');
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

/**
 * PUT /api/auth/profile
 * Update current user's profile
 */
router.put('/auth/profile', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { full_name, phone } = req.body;

  try {
    const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (full_name !== undefined) updates.full_name = full_name;
    if (phone !== undefined) updates.phone = phone;

    const { data, error } = await supabase
      .from('customer_profiles')
      .update(updates)
      .eq('id', userId)
      .select()
      .single();

    if (error) {
      res.status(500).json({ error: 'Failed to update profile' });
      return;
    }

    // Sync name/phone to Odoo partner if exists
    if (data?.odoo_partner_id) {
      try {
        const partnerUpdates: Record<string, unknown> = {};
        if (full_name) partnerUpdates.name = full_name;
        if (phone) partnerUpdates.phone = phone;
        if (Object.keys(partnerUpdates).length > 0) {
          await odooWrite('res.partner', [data.odoo_partner_id], partnerUpdates);
        }
      } catch (odooErr) {
        logger.warn({ err: odooErr }, 'Failed to sync profile to Odoo (non-blocking)');
      }
    }

    res.json(data);
  } catch (err) {
    logger.error({ err }, 'Update profile error');
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

export default router;
