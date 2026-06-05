import { describe, expect, it } from 'vitest';
import { CRON_STATUS_META, cronStatusIsAlarming, fmtLastRun } from './cronHealthFormat.ts';

describe('cronStatusIsAlarming', () => {
  it('flags only stale and missing', () => {
    expect(cronStatusIsAlarming('stale')).toBe(true);
    expect(cronStatusIsAlarming('missing')).toBe(true);
    expect(cronStatusIsAlarming('healthy')).toBe(false);
    expect(cronStatusIsAlarming('pending')).toBe(false);
    expect(cronStatusIsAlarming('disabled')).toBe(false);
  });
});

describe('CRON_STATUS_META', () => {
  it('maps every status to a tone and label', () => {
    for (const status of ['healthy', 'pending', 'stale', 'missing', 'disabled'] as const) {
      expect(CRON_STATUS_META[status].tone).toBeTruthy();
      expect(CRON_STATUS_META[status].label).toBeTruthy();
    }
  });

  it('uses the alarm red tone for missing and the soft amber for stale', () => {
    expect(CRON_STATUS_META.missing.tone).toBe('no_show');
    expect(CRON_STATUS_META.stale.tone).toBe('unsuitable');
    expect(CRON_STATUS_META.healthy.tone).toBe('arrived');
  });
});

describe('fmtLastRun', () => {
  const now = Date.parse('2026-06-05T10:45:00Z');

  it('returns Never for a null timestamp', () => {
    expect(fmtLastRun(null, now)).toBe('Never');
  });

  it('reads "just now" under a minute', () => {
    expect(fmtLastRun('2026-06-05T10:44:40Z', now)).toMatch(/^just now ·/);
  });

  it('reads minutes for under an hour', () => {
    expect(fmtLastRun('2026-06-05T10:40:00Z', now)).toMatch(/^5 min ago ·/);
  });

  it('reads hours for under a day', () => {
    expect(fmtLastRun('2026-06-05T08:45:00Z', now)).toMatch(/^2 h ago ·/);
  });

  it('reads days beyond 24 hours', () => {
    expect(fmtLastRun('2026-06-03T10:45:00Z', now)).toMatch(/^2 d ago ·/);
  });

  it('appends an absolute London-time stamp with tz abbreviation', () => {
    // 10:45 UTC in June is 11:45 BST.
    expect(fmtLastRun('2026-06-05T10:45:00Z', now)).toContain('11:45 BST');
  });
});
