import admin from 'firebase-admin';
import { env } from '../config/env.js';
import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';

let firebaseInitialized = false;

function ensureFirebase() {
  if (firebaseInitialized) return true;

  const { FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY } = env;
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    return false;
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        // The private key comes escaped in .env — need to unescape newlines
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    firebaseInitialized = true;
    logger.info('Firebase Admin SDK initialized');
    return true;
  } catch (err) {
    logger.warn({ err }, 'Failed to initialize Firebase Admin SDK');
    return false;
  }
}

// ----------------------------------------------------------------
// Token management
// ----------------------------------------------------------------

/**
 * Register an FCM push token for a user
 */
export async function registerToken(
  userId: string,
  token: string,
  platform: 'ios' | 'android',
): Promise<void> {
  // Upsert: if token already exists for another user, reassign it
  const { error } = await supabase
    .from('push_tokens')
    .upsert(
      { user_id: userId, token, platform },
      { onConflict: 'token' },
    );

  if (error) {
    logger.error({ error, userId }, 'Failed to register push token');
    throw new Error('Failed to register push token');
  }
}

/**
 * Remove an FCM token (on logout or app uninstall)
 */
export async function removeToken(token: string): Promise<void> {
  await supabase.from('push_tokens').delete().eq('token', token);
}

/**
 * Get all FCM tokens for a user
 */
async function getUserTokens(userId: string): Promise<string[]> {
  const { data } = await supabase
    .from('push_tokens')
    .select('token')
    .eq('user_id', userId);

  return data?.map((t) => t.token) ?? [];
}

// ----------------------------------------------------------------
// Send notifications
// ----------------------------------------------------------------

interface PushPayload {
  title: string;
  body: string;
  data?: Record<string, string>;
}

/**
 * Send a push notification to a specific user (all their devices).
 * Also saves the notification to the history table.
 *
 * @returns number of successfully sent messages
 */
export async function sendToUser(
  userId: string,
  payload: PushPayload,
  options?: {
    type?: 'order' | 'promo' | 'system';
    referenceId?: string;
    skipHistory?: boolean;
  },
): Promise<number> {
  // 1. Save to notification history (regardless of FCM availability)
  if (!options?.skipHistory) {
    await supabase.from('notifications').insert({
      user_id: userId,
      title: payload.title,
      body: payload.body,
      type: options?.type ?? 'order',
      reference_id: options?.referenceId ?? null,
    });
  }

  // 2. Send via FCM
  if (!ensureFirebase()) {
    logger.info({ userId, title: payload.title }, 'FCM not configured — notification saved to DB only');
    return 0;
  }

  const tokens = await getUserTokens(userId);
  if (tokens.length === 0) {
    logger.info({ userId }, 'No FCM tokens registered for user');
    return 0;
  }

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: payload.data,
    android: {
      priority: 'high',
      notification: {
        channelId: 'orders',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
          badge: 1,
        },
      },
    },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    logger.info(
      { userId, success: response.successCount, failure: response.failureCount },
      'Push notification sent',
    );

    // Clean up invalid tokens
    if (response.failureCount > 0) {
      const invalidTokens: string[] = [];
      response.responses.forEach((resp, i) => {
        if (resp.error?.code === 'messaging/registration-token-not-registered' ||
            resp.error?.code === 'messaging/invalid-registration-token') {
          invalidTokens.push(tokens[i]);
        }
      });
      if (invalidTokens.length > 0) {
        await supabase
          .from('push_tokens')
          .delete()
          .in('token', invalidTokens);
        logger.info({ count: invalidTokens.length }, 'Cleaned up invalid FCM tokens');
      }
    }

    return response.successCount;
  } catch (err) {
    logger.error({ err, userId }, 'Failed to send push notification');
    return 0;
  }
}

// ----------------------------------------------------------------
// Order-specific notification helpers
// ----------------------------------------------------------------

const STATUS_MESSAGES: Record<string, { title: string; body: string }> = {
  confirmed: {
    title: 'Pedido Confirmado',
    body: 'Tu pedido ha sido confirmado y está siendo procesado.',
  },
  preparing: {
    title: 'Preparando tu Pedido',
    body: 'Estamos preparando tu pedido. ¡Ya casi está listo!',
  },
  ready_pickup: {
    title: 'Pedido Listo para Retirar',
    body: 'Tu pedido está listo. Pasa a recogerlo a la sucursal.',
  },
  shipping: {
    title: 'Pedido en Camino',
    body: 'Tu pedido va en camino. ¡Pronto llega!',
  },
  delivered: {
    title: 'Pedido Entregado',
    body: '¡Tu pedido ha sido entregado! Gracias por tu compra.',
  },
  cancelled: {
    title: 'Pedido Cancelado',
    body: 'Tu pedido ha sido cancelado.',
  },
};

/**
 * Send an order status change notification
 */
export async function notifyOrderStatusChange(
  userId: string,
  orderId: string,
  newStatus: string,
  customMessage?: string,
): Promise<void> {
  const template = STATUS_MESSAGES[newStatus];
  if (!template && !customMessage) return;

  await sendToUser(
    userId,
    {
      title: template?.title ?? 'Actualización de Pedido',
      body: customMessage ?? template?.body ?? `Estado actualizado: ${newStatus}`,
      data: {
        type: 'order_update',
        order_id: orderId,
        status: newStatus,
      },
    },
    {
      type: 'order',
      referenceId: orderId,
    },
  );
}
