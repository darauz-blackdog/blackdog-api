import { Router } from 'express';
import type { Request, Response } from 'express';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { registerToken, removeToken } from '../services/push.service.js';

const router = Router();

// ================================================================
// PUSH TOKEN MANAGEMENT
// ================================================================

/**
 * POST /api/push-tokens
 * Register an FCM token for the current user
 * Body: { token, platform }
 */
router.post('/push-tokens', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const { token, platform } = req.body;

  if (!token || typeof token !== 'string') {
    res.status(400).json({ error: 'token is required' });
    return;
  }
  if (!platform || !['ios', 'android'].includes(platform)) {
    res.status(400).json({ error: 'platform must be "ios" or "android"' });
    return;
  }

  try {
    await registerToken(userId, token, platform);
    res.json({ message: 'Token registered' });
  } catch (err) {
    logger.error({ err }, 'Register push token error');
    res.status(500).json({ error: 'Failed to register token' });
  }
});

/**
 * DELETE /api/push-tokens
 * Remove an FCM token (on logout)
 * Body: { token }
 */
router.delete('/push-tokens', requireAuth, async (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    res.status(400).json({ error: 'token is required' });
    return;
  }

  try {
    await removeToken(token);
    res.json({ message: 'Token removed' });
  } catch (err) {
    logger.error({ err }, 'Remove push token error');
    res.status(500).json({ error: 'Failed to remove token' });
  }
});

// ================================================================
// NOTIFICATION HISTORY
// ================================================================

/**
 * GET /api/notifications
 * List notifications for the current user
 * Query: ?page=1&limit=20&unread_only=true
 */
router.get('/notifications', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const page = Math.max(1, parseInt(req.query.page as string) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit as string) || 20));
  const offset = (page - 1) * limit;
  const unreadOnly = req.query.unread_only === 'true';

  try {
    let query = supabase
      .from('notifications')
      .select('*', { count: 'exact' })
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (unreadOnly) {
      query = query.eq('is_read', false);
    }

    const { data, error, count } = await query;

    if (error) {
      res.status(500).json({ error: 'Failed to fetch notifications' });
      return;
    }

    // Also get unread count
    const { count: unreadCount } = await supabase
      .from('notifications')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    res.json({
      data,
      unread_count: unreadCount ?? 0,
      pagination: {
        page,
        limit,
        total: count ?? 0,
        total_pages: Math.ceil((count ?? 0) / limit),
      },
    });
  } catch (err) {
    logger.error({ err }, 'List notifications error');
    res.status(500).json({ error: 'Failed to fetch notifications' });
  }
});

/**
 * PUT /api/notifications/:id/read
 * Mark a single notification as read
 */
router.put('/notifications/:id/read', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;
  const notifId = req.params.id;

  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('id', notifId)
      .eq('user_id', userId);

    if (error) {
      res.status(500).json({ error: 'Failed to mark notification as read' });
      return;
    }

    res.json({ message: 'Notification marked as read' });
  } catch (err) {
    logger.error({ err }, 'Mark notification read error');
    res.status(500).json({ error: 'Failed to update notification' });
  }
});

/**
 * PUT /api/notifications/read-all
 * Mark all notifications as read for the current user
 */
router.put('/notifications/read-all', requireAuth, async (req: Request, res: Response) => {
  const { id: userId } = (req as AuthenticatedRequest).user;

  try {
    const { error } = await supabase
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', userId)
      .eq('is_read', false);

    if (error) {
      res.status(500).json({ error: 'Failed to mark notifications as read' });
      return;
    }

    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    logger.error({ err }, 'Mark all read error');
    res.status(500).json({ error: 'Failed to update notifications' });
  }
});

export default router;
