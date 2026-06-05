import type { StatusTone } from '../components/StatusPill/StatusPill.tsx';
import type { CronJobStatus } from './queries/cronHealth.ts';
import { fmtTzAbbr } from './dateFormat.ts';

// Pure presentation helpers for the System health panel. Kept React-free
// so they are unit-testable in the node environment.

export const CRON_STATUS_META: Record<CronJobStatus, { tone: StatusTone; label: string }> = {
  healthy: { tone: 'arrived', label: 'Healthy' },
  pending: { tone: 'pending', label: 'Awaiting first run' },
  stale: { tone: 'unsuitable', label: 'Stale' },
  missing: { tone: 'no_show', label: 'Missing' },
  disabled: { tone: 'neutral', label: 'Disabled' },
};

// A monitored job needs attention only when it is stale or missing.
export function cronStatusIsAlarming(status: CronJobStatus): boolean {
  return status === 'stale' || status === 'missing';
}

// "4 min ago · 05 Jun 10:45 BST". nowMs is injectable for tests.
export function fmtLastRun(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return 'Never';
  const mins = Math.round((nowMs - new Date(iso).getTime()) / 60000);
  let rel: string;
  if (mins < 1) rel = 'just now';
  else if (mins < 60) rel = `${mins} min ago`;
  else if (mins < 60 * 24) rel = `${Math.round(mins / 60)} h ago`;
  else rel = `${Math.round(mins / (60 * 24))} d ago`;
  const abs = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${rel} · ${abs} ${fmtTzAbbr(iso)}`;
}
