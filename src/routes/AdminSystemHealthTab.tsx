import { Activity, Check, Clock, RefreshCw, ShieldAlert } from 'lucide-react';
import { Button, Card, EmptyState, Skeleton, StatusPill } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import { type CronHealthRow, useCronHealth } from '../lib/queries/cronHealth.ts';
import { CRON_STATUS_META, cronStatusIsAlarming, fmtLastRun } from '../lib/cronHealthFormat.ts';

// System health
//
// At-a-glance status of every critical pg_cron sweep, backed by the
// lng_cron_health() RPC and the lng_run_cron_watchdog() checker. Exists
// because three scheduled jobs were silently deleted on ~11 May 2026 and
// nothing surfaced it for 3.5 weeks. A red row here, plus an open failure
// in the Failures tab, now appears within 15 minutes of a job stopping.

export function AdminSystemHealthTab() {
  const { rows, loading, error, refresh } = useCronHealth();

  const problems = rows.filter((r) => cronStatusIsAlarming(r.status));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <Card padding="lg">
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: theme.space[3] }}>
          <div>
            <h2 style={{ margin: 0, fontSize: theme.type.size.lg, fontWeight: theme.type.weight.semibold }}>
              Scheduled jobs
            </h2>
            <p style={{ margin: `${theme.space[2]}px 0 0`, color: theme.color.inkMuted, fontSize: theme.type.size.sm, maxWidth: 560 }}>
              Background sweeps the app depends on. The watchdog checks each one every 15 minutes and raises a failure the moment a job stops running. An external dead man's switch monitors the watchdog itself.
            </p>
          </div>
          <Button variant="tertiary" onClick={refresh}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <RefreshCw size={16} /> Refresh
            </span>
          </Button>
        </div>

        <div style={{ marginTop: theme.space[4] }}>
          {loading ? (
            <Skeleton height={180} />
          ) : error ? (
            <div
              style={{
                padding: theme.space[4],
                background: theme.color.bg,
                borderRadius: theme.radius.card,
                color: theme.color.inkMuted,
                fontSize: theme.type.size.sm,
                display: 'inline-flex',
                alignItems: 'center',
                gap: theme.space[2],
              }}
            >
              <ShieldAlert size={16} /> Could not load health. {error}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<Activity size={24} />} title="No jobs monitored" description="Add a row to lng_cron_watchdog_expectations to start watching a sweep." />
          ) : (
            <>
              <div
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: theme.space[2],
                  marginBottom: theme.space[4],
                  fontSize: theme.type.size.sm,
                  fontWeight: theme.type.weight.medium,
                  color: problems.length === 0 ? theme.color.ink : theme.color.inkMuted,
                }}
              >
                {problems.length === 0 ? (
                  <>
                    <Check size={16} /> All {rows.length} jobs healthy
                  </>
                ) : (
                  <>
                    <ShieldAlert size={16} /> {problems.length} of {rows.length} jobs need attention
                  </>
                )}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {rows.map((r) => (
                  <JobRow key={r.jobname} row={r} />
                ))}
              </div>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}

function JobRow({ row }: { row: CronHealthRow }) {
  const meta = CRON_STATUS_META[row.status];
  const alarming = cronStatusIsAlarming(row.status);
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: alarming ? theme.color.bg : theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderLeft: `3px solid ${alarming ? theme.color.alert : theme.color.accent}`,
        borderRadius: theme.radius.card,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: theme.color.ink }}>
          {row.description}
        </div>
        <div
          style={{
            marginTop: 2,
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
          }}
        >
          <Clock size={11} /> Last run: {fmtLastRun(row.last_success)}
          <span style={{ color: theme.color.border }}>·</span>
          <code style={{ fontFamily: 'ui-monospace, monospace' }}>{row.jobname}</code>
        </div>
      </div>
      <StatusPill tone={meta.tone} size="sm">{meta.label}</StatusPill>
    </div>
  );
}
