// Client-side helper for writing structured failures to lng_system_failures.
// Per brief §1 + §8.6: failures are loud and logged; never swallowed.

import { supabase } from './supabase.ts';

export type FailureSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface FailureContext {
  source: string;
  severity: FailureSeverity;
  message: string;
  context?: Record<string, unknown>;
}

export async function logFailure(failure: FailureContext): Promise<void> {
  // Best-effort. If logging itself fails, fall through to console so the
  // operator is not blind. Never throw from inside this helper.
  try {
    const { error } = await supabase.from('lng_system_failures').insert({
      source: failure.source,
      severity: failure.severity,
      message: failure.message,
      context: failure.context ?? {},
    });
    if (error) {
      console.error('[lng_system_failures insert failed]', error, failure);
    }
  } catch (err) {
    console.error('[lng_system_failures unreachable]', err, failure);
  }
}
