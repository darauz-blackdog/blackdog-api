import { createClient } from '@supabase/supabase-js';
import { env } from './env.js';

// Service role client for backend operations (bypasses RLS)
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// Anon client for auth verification
export const supabaseAnon = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
