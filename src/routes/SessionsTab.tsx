import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronRight,
  Globe,
  Laptop,
  MapPin,
  Monitor,
  RefreshCw,
  ShieldAlert,
  Smartphone,
  Tablet,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { Avatar, Button, Card, EmptyState, Skeleton, Toast } from '../components/index.ts';
import { BottomSheet } from '../components/BottomSheet/BottomSheet.tsx';
import { theme } from '../theme/index.ts';
import { useIsMobile } from '../lib/useIsMobile.ts';
import {
  forceLogoutStaff,
  getStaffSessions,
  lookupIpLocations,
  type IpLocation,
  type StaffSession,
  type StaffSessionRow,
} from '../lib/queries/staffSessions.ts';

// A staff member is "online" if any of their sessions refreshed within this
// window. GoTrue refreshes the access token well inside its 1h life while the
// app is open, so a sub-15-minute window tracks live presence closely without
// flickering people offline between refreshes.
const ONLINE_WINDOW_MS = 12 * 60 * 1000;
// Quietly re-pull session state on this cadence so presence stays live.
const REFRESH_MS = 30 * 1000;

type FilterKey = 'all' | 'online' | 'flagged';

interface DeviceInfo {
  label: string;
  Icon: typeof Monitor;
}

function parseDevice(ua: string | null): DeviceInfo {
  if (!ua) return { label: 'Unknown device', Icon: Globe };
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Chrome\//.test(ua) && !/Chromium/.test(ua)
      ? 'Chrome'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Safari\//.test(ua)
          ? 'Safari'
          : null;
  const withBrowser = (os: string, Icon: typeof Monitor): DeviceInfo => ({
    label: browser ? `${os} · ${browser}` : os,
    Icon,
  });
  if (/iPhone/.test(ua)) return withBrowser('iPhone', Smartphone);
  if (/iPad/.test(ua)) return withBrowser('iPad', Tablet);
  if (/Android/.test(ua)) return withBrowser(/Mobile/.test(ua) ? 'Android phone' : 'Android tablet', Smartphone);
  if (/Macintosh|Mac OS X/.test(ua)) return withBrowser('Mac', Laptop);
  if (/Windows/.test(ua)) return withBrowser('Windows', Monitor);
  if (/Linux/.test(ua)) return withBrowser('Linux', Monitor);
  return withBrowser('Browser', Globe);
}

function relativeTime(ms: number | null, nowMs: number): string {
  if (ms == null) return '—';
  const diff = Math.max(0, nowMs - ms);
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function sessionActivityMs(s: StaffSession): number {
  return new Date(s.refreshed_at ?? s.created_at).getTime();
}

interface Derived {
  row: StaffSessionRow;
  name: string;
  online: boolean;
  lastActivityMs: number | null;
  deviceCount: number;
  primaryLocation: string | null;
  countryCount: number;
  flagged: boolean;
  sortedSessions: StaffSession[];
}

function deriveRow(row: StaffSessionRow, geo: Map<string, IpLocation>, nowMs: number): Derived {
  const name = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() || row.login_email;
  const sortedSessions = [...row.sessions].sort((a, b) => sessionActivityMs(b) - sessionActivityMs(a));
  const lastActivityMs = sortedSessions.length > 0 ? sessionActivityMs(sortedSessions[0]!) : null;
  const online = lastActivityMs != null && nowMs - lastActivityMs <= ONLINE_WINDOW_MS;

  const countries = new Set<string>();
  for (const s of sortedSessions) {
    if (!s.ip) continue;
    const loc = geo.get(s.ip);
    if (loc?.countryCode) countries.add(loc.countryCode);
  }

  const top = sortedSessions[0];
  const topLoc = top?.ip ? geo.get(top.ip) : undefined;
  const primaryLocation = topLoc?.label ?? top?.ip ?? null;

  return {
    row,
    name,
    online,
    lastActivityMs,
    deviceCount: sortedSessions.length,
    primaryLocation,
    countryCount: countries.size,
    flagged: countries.size > 1,
    sortedSessions,
  };
}

export function SessionsTab() {
  const isMobile = useIsMobile(640);
  const [rows, setRows] = useState<StaffSessionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [geo, setGeo] = useState<Map<string, IpLocation>>(new Map());
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [now, setNow] = useState(() => Date.now());
  const [detail, setDetail] = useState<string | null>(null); // staff_member_id
  const [confirming, setConfirming] = useState(false);
  const [signOutBusy, setSignOutBusy] = useState(false);
  const [toast, setToast] = useState<{ tone: 'success' | 'error'; title: string; description?: string } | null>(null);

  const detailOpenRef = useRef(false);
  detailOpenRef.current = detail != null;

  const enrichGeo = useCallback(async (data: StaffSessionRow[]) => {
    const ips = data.flatMap((r) => r.sessions.map((s) => s.ip).filter((ip): ip is string => !!ip));
    if (ips.length === 0) return;
    const map = await lookupIpLocations(ips);
    if (map.size > 0) setGeo((prev) => new Map([...prev, ...map]));
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      if (!silent) setError(null);
      setRefreshing(true);
      try {
        const data = await getStaffSessions();
        setRows(data);
        setUpdatedAt(Date.now());
        void enrichGeo(data);
      } catch (e) {
        if (!silent) setError(e instanceof Error ? e.message : 'Could not load staff sessions.');
      } finally {
        setRefreshing(false);
      }
    },
    [enrichGeo],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  // Live clock for relative times + a quiet refetch, paused while a sheet is
  // open so presence never shifts under an admin mid-action.
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(Date.now());
      if (!detailOpenRef.current && !confirming) void load(true);
    }, REFRESH_MS);
    return () => clearInterval(tick);
  }, [load, confirming]);

  const derived = useMemo(() => {
    if (!rows) return [];
    return rows
      .map((r) => deriveRow(r, geo, now))
      .sort((a, b) => {
        if (a.flagged !== b.flagged) return a.flagged ? -1 : 1;
        if (a.online !== b.online) return a.online ? -1 : 1;
        return (b.lastActivityMs ?? 0) - (a.lastActivityMs ?? 0);
      });
  }, [rows, geo, now]);

  const onlineCount = derived.filter((d) => d.online).length;
  const signedInCount = derived.filter((d) => d.deviceCount > 0).length;
  const flaggedCount = derived.filter((d) => d.flagged).length;

  const visible = useMemo(() => {
    if (filter === 'online') return derived.filter((d) => d.online);
    if (filter === 'flagged') return derived.filter((d) => d.flagged);
    return derived;
  }, [derived, filter]);

  const detailRow = useMemo(() => derived.find((d) => d.row.staff_member_id === detail) ?? null, [derived, detail]);

  const closeDetail = () => {
    if (signOutBusy) return;
    setDetail(null);
    setConfirming(false);
  };

  const handleSignOut = async () => {
    if (!detailRow) return;
    setSignOutBusy(true);
    try {
      const killed = await forceLogoutStaff(detailRow.row.staff_member_id);
      setToast({
        tone: 'success',
        title: `Signed ${detailRow.name} out`,
        description:
          killed === 0
            ? 'They had no active sessions to end.'
            : `Ended ${killed} session${killed === 1 ? '' : 's'}. They will need to sign in again.`,
      });
      setDetail(null);
      setConfirming(false);
      await load(true);
    } catch (e) {
      setToast({
        tone: 'error',
        title: 'Could not sign them out',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSignOutBusy(false);
    }
  };

  return (
    <div>
      <style>{`@keyframes lng-pulse-dot{0%{box-shadow:0 0 0 0 rgba(31,77,58,0.35)}70%{box-shadow:0 0 0 6px rgba(31,77,58,0)}100%{box-shadow:0 0 0 0 rgba(31,77,58,0)}}`}</style>

      <p
        style={{
          margin: `0 0 ${theme.space[5]}px`,
          fontSize: theme.type.size.sm,
          lineHeight: theme.type.leading.normal,
          color: theme.color.inkMuted,
          maxWidth: 640,
        }}
      >
        Every staff member, where and when they are signed in. Spot an account in use from two places at once, then sign
        a lost or shared device out remotely. Sessions read live from the login system.
      </p>

      {/* Summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: isMobile ? theme.space[2] : theme.space[3],
          marginBottom: theme.space[5],
        }}
      >
        <StatCard icon={<Wifi size={16} aria-hidden />} value={onlineCount} label="Online now" tone="accent" loading={rows == null} />
        <StatCard icon={<Globe size={16} aria-hidden />} value={signedInCount} label="Signed in" tone="ink" loading={rows == null} />
        <StatCard
          icon={<ShieldAlert size={16} aria-hidden />}
          value={flaggedCount}
          label="Flagged"
          tone={flaggedCount > 0 ? 'warn' : 'ink'}
          loading={rows == null}
        />
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginBottom: theme.space[4], flexWrap: 'wrap' }}>
        <FilterChip label="All" count={derived.length} active={filter === 'all'} onClick={() => setFilter('all')} />
        <FilterChip label="Online" count={onlineCount} active={filter === 'online'} onClick={() => setFilter('online')} />
        <FilterChip label="Flagged" count={flaggedCount} active={filter === 'flagged'} onClick={() => setFilter('flagged')} tone="warn" />
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: theme.space[3] }}>
          {updatedAt != null ? (
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              Updated {relativeTime(updatedAt, now)}
            </span>
          ) : null}
          <Button variant="secondary" size="sm" onClick={() => void load(false)} loading={refreshing}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1] }}>
              <RefreshCw size={14} aria-hidden /> Refresh
            </span>
          </Button>
        </div>
      </div>

      {/* List */}
      {error ? (
        <Card padding="lg">
          <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert }}>{error}</p>
        </Card>
      ) : rows == null ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} height={84} radius={theme.radius.card} />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={<WifiOff size={26} aria-hidden />}
          title={filter === 'flagged' ? 'Nothing flagged' : filter === 'online' ? 'Nobody online' : 'No staff'}
          description={
            filter === 'flagged'
              ? 'No account is signed in from more than one country.'
              : filter === 'online'
                ? 'No staff member has been active in the last few minutes.'
                : 'No Lounge staff to show.'
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
          {visible.map((d) => (
            <StaffRow key={d.row.staff_member_id} d={d} now={now} isMobile={isMobile} onOpen={() => setDetail(d.row.staff_member_id)} />
          ))}
        </div>
      )}

      {/* Detail sheet */}
      <BottomSheet
        open={detail != null}
        onClose={closeDetail}
        dismissable={!signOutBusy}
        title={detailRow?.name ?? ''}
        description={detailRow?.row.login_email}
      >
        {detailRow ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[4] }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.space[2] }}>
              {detailRow.row.is_admin ? <Chip label="Admin" tone="admin" /> : null}
              {detailRow.row.is_manager ? <Chip label="Manager" tone="manager" /> : null}
              {!detailRow.row.is_admin && !detailRow.row.is_manager ? <Chip label="Staff" tone="neutral" /> : null}
              {detailRow.row.status !== 'active' ? <Chip label="Deactivated" tone="neutral" /> : null}
            </div>

            <div style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              Last sign-in {formatDateTime(detailRow.row.last_sign_in_at)}
            </div>

            {detailRow.flagged ? (
              <div
                style={{
                  display: 'flex',
                  gap: theme.space[2],
                  alignItems: 'flex-start',
                  padding: theme.space[3],
                  borderRadius: theme.radius.input,
                  background: 'rgba(179, 104, 21, 0.08)',
                  color: theme.color.warn,
                  fontSize: theme.type.size.sm,
                  lineHeight: theme.type.leading.snug,
                }}
              >
                <ShieldAlert size={16} aria-hidden style={{ flexShrink: 0, marginTop: 1 }} />
                <span>
                  Signed in from {detailRow.countryCount} different countries. If this person is in one place, the account
                  may be shared. Sign them out and have them change their password.
                </span>
              </div>
            ) : null}

            {detailRow.sortedSessions.length === 0 ? (
              <Card padding="md" elevation="flat">
                <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
                  Not signed in on any device.
                </p>
              </Card>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
                {detailRow.sortedSessions.map((s) => (
                  <SessionRow key={s.id} s={s} geo={geo} now={now} />
                ))}
              </div>
            )}

            {/* Danger zone */}
            <div
              style={{
                marginTop: theme.space[2],
                paddingTop: theme.space[4],
                borderTop: `1px solid ${theme.color.border}`,
              }}
            >
              {confirming ? (
                <div style={{ display: 'flex', gap: theme.space[3], alignItems: 'center', flexWrap: 'wrap' }}>
                  <p style={{ margin: 0, fontSize: theme.type.size.sm, color: theme.color.alert, fontWeight: theme.type.weight.semibold }}>
                    Sign {detailRow.name} out of every device?
                  </p>
                  <div style={{ display: 'flex', gap: theme.space[2], marginLeft: 'auto' }}>
                    <Button variant="tertiary" size="sm" onClick={() => setConfirming(false)} disabled={signOutBusy}>
                      Cancel
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => void handleSignOut()} loading={signOutBusy}>
                      Confirm sign out
                    </Button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: theme.space[3] }}>
                  <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
                    Ends all sessions. Their password is unchanged.
                  </span>
                  <Button variant="secondary" size="sm" onClick={() => setConfirming(true)} disabled={detailRow.deviceCount === 0}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], color: detailRow.deviceCount === 0 ? undefined : theme.color.alert }}>
                      <WifiOff size={14} aria-hidden /> Sign out everywhere
                    </span>
                  </Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div />
        )}
      </BottomSheet>

      {toast ? (
        <Toast tone={toast.tone} title={toast.title} description={toast.description} onDismiss={() => setToast(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

function StatCard({
  icon,
  value,
  label,
  tone,
  loading,
}: {
  icon: React.ReactNode;
  value: number;
  label: string;
  tone: 'accent' | 'ink' | 'warn';
  loading: boolean;
}) {
  const valueColor = tone === 'accent' ? theme.color.accent : tone === 'warn' ? theme.color.warn : theme.color.ink;
  return (
    <Card padding="md">
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
        <span style={{ color: theme.color.inkSubtle, display: 'inline-flex' }}>{icon}</span>
        {loading ? (
          <Skeleton width={40} height={30} />
        ) : (
          <span
            style={{
              fontSize: theme.type.size.xxl,
              fontWeight: theme.type.weight.semibold,
              letterSpacing: theme.type.tracking.tight,
              lineHeight: 1,
              color: valueColor,
            }}
          >
            {value}
          </span>
        )}
        <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>{label}</span>
      </div>
    </Card>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
  tone,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  tone?: 'warn';
}) {
  const style: CSSProperties = {
    appearance: 'none',
    border: active ? `1px solid ${theme.color.ink}` : `1px solid ${theme.color.border}`,
    background: active ? theme.color.ink : theme.color.surface,
    color: active ? theme.color.surface : tone === 'warn' && count > 0 ? theme.color.warn : theme.color.ink,
    fontFamily: 'inherit',
    fontSize: theme.type.size.sm,
    fontWeight: theme.type.weight.medium,
    height: 36,
    padding: `0 ${theme.space[3]}px`,
    borderRadius: theme.radius.pill,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: theme.space[2],
    transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
  };
  return (
    <button type="button" aria-pressed={active} style={style} onClick={onClick}>
      {label}
      <span
        style={{
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.semibold,
          color: active ? 'rgba(255,255,255,0.7)' : theme.color.inkSubtle,
        }}
      >
        {count}
      </span>
    </button>
  );
}

function Chip({ label, tone }: { label: string; tone: 'admin' | 'manager' | 'flag' | 'neutral' }) {
  const map: Record<string, { bg: string; fg: string }> = {
    admin: { bg: theme.color.accentBg, fg: theme.color.accent },
    manager: { bg: 'rgba(30, 91, 168, 0.10)', fg: '#1E5BA8' },
    flag: { bg: 'rgba(179, 104, 21, 0.10)', fg: theme.color.warn },
    neutral: { bg: 'rgba(14, 20, 20, 0.05)', fg: theme.color.inkMuted },
  };
  const c = map[tone]!;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        height: 24,
        padding: `0 ${theme.space[2]}px`,
        borderRadius: theme.radius.pill,
        background: c.bg,
        color: c.fg,
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
      }}
    >
      {tone === 'flag' ? <ShieldAlert size={11} aria-hidden /> : null}
      {label}
    </span>
  );
}

function PresenceDot({ online }: { online: boolean }) {
  return (
    <span
      style={{
        width: 8,
        height: 8,
        borderRadius: theme.radius.pill,
        background: online ? theme.color.accent : theme.color.inkSubtle,
        flexShrink: 0,
        animation: online ? 'lng-pulse-dot 2s infinite' : undefined,
      }}
      aria-hidden
    />
  );
}

function StaffRow({ d, now, isMobile, onOpen }: { d: Derived; now: number; isMobile: boolean; onOpen: () => void }) {
  const statusText = d.online ? 'Active now' : d.lastActivityMs != null ? `Active ${relativeTime(d.lastActivityMs, now)}` : 'Signed out';

  const presence = (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: isMobile ? 'flex-start' : 'flex-end', gap: 4, minWidth: 0 }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[2], fontSize: theme.type.size.sm, fontWeight: theme.type.weight.medium, color: d.online ? theme.color.ink : theme.color.inkMuted }}>
        <PresenceDot online={d.online} />
        {statusText}
      </span>
      {d.primaryLocation ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: theme.space[1], fontSize: theme.type.size.xs, color: theme.color.inkSubtle, maxWidth: isMobile ? '100%' : 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          <MapPin size={11} aria-hidden style={{ flexShrink: 0 }} />
          {d.primaryLocation}
        </span>
      ) : null}
      {d.deviceCount > 0 ? (
        <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
          {d.deviceCount} device{d.deviceCount === 1 ? '' : 's'}
        </span>
      ) : null}
    </div>
  );

  return (
    <Card interactive padding="md" onClick={onOpen}>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[4] }}>
        <Avatar name={d.name} size="md" badge={d.online ? 'online' : 'offline'} />

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], flexWrap: 'wrap' }}>
            <span style={{ fontSize: theme.type.size.base, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
              {d.name}
            </span>
            {d.row.is_admin ? <Chip label="Admin" tone="admin" /> : null}
            {d.row.is_manager ? <Chip label="Manager" tone="manager" /> : null}
            {d.flagged ? <Chip label={`${d.countryCount} countries`} tone="flag" /> : null}
          </div>
          <div style={{ marginTop: 2, fontSize: theme.type.size.sm, color: theme.color.inkMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {d.row.login_email}
          </div>
          {isMobile ? <div style={{ marginTop: theme.space[2] }}>{presence}</div> : null}
        </div>

        {!isMobile ? presence : null}
        <ChevronRight size={18} aria-hidden style={{ color: theme.color.inkSubtle, flexShrink: 0 }} />
      </div>
    </Card>
  );
}

function SessionRow({ s, geo, now }: { s: StaffSession; geo: Map<string, IpLocation>; now: number }) {
  const device = parseDevice(s.user_agent);
  const loc = s.ip ? geo.get(s.ip) : undefined;
  const activeMs = sessionActivityMs(s);
  const online = now - activeMs <= ONLINE_WINDOW_MS;
  const Icon = device.Icon;

  return (
    <Card padding="md" elevation="flat">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: theme.space[3] }}>
        <span
          style={{
            width: 36,
            height: 36,
            borderRadius: theme.radius.input,
            background: 'rgba(14, 20, 20, 0.04)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: theme.color.ink,
            flexShrink: 0,
          }}
        >
          <Icon size={18} aria-hidden />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
            <span style={{ fontSize: theme.type.size.sm, fontWeight: theme.type.weight.semibold, color: theme.color.ink }}>
              {device.label}
            </span>
            <PresenceDot online={online} />
            <span style={{ fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
              {online ? 'Active now' : relativeTime(activeMs, now)}
            </span>
          </div>
          <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: theme.space[1], fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
            <MapPin size={12} aria-hidden style={{ flexShrink: 0 }} />
            {loc?.label ?? s.ip ?? 'Unknown location'}
            {loc && s.ip ? <span style={{ color: theme.color.inkSubtle }}>· {s.ip}</span> : null}
          </div>
          <div style={{ marginTop: 2, fontSize: theme.type.size.xs, color: theme.color.inkSubtle }}>
            Signed in {formatDateTime(s.created_at)}
          </div>
        </div>
      </div>
    </Card>
  );
}
