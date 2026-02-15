import { supabase } from '../config/supabase.js';
import { logger } from '../config/logger.js';

/** Log a sync run to the sync_logs table */
export async function logSync(
  jobName: string,
  status: 'success' | 'error',
  recordsSynced: number,
  durationMs: number,
  errorMessage?: string
) {
  const { error } = await supabase.from('sync_logs').insert({
    job_name: jobName,
    status,
    records_synced: recordsSynced,
    duration_ms: durationMs,
    error_message: errorMessage ?? null,
    started_at: new Date(Date.now() - durationMs).toISOString(),
    finished_at: new Date().toISOString(),
  });

  if (error) {
    logger.warn({ error, jobName }, 'Failed to log sync result');
  }
}

/** Get the last successful sync timestamp for a job */
export async function getLastSyncTimestamp(jobName: string): Promise<string> {
  const { data } = await supabase
    .from('sync_logs')
    .select('finished_at')
    .eq('job_name', jobName)
    .eq('status', 'success')
    .order('finished_at', { ascending: false })
    .limit(1)
    .single();

  // Default: 30 days ago (for first run)
  return data?.finished_at ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
}
