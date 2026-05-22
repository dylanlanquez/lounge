// Shared date / time helpers for every Lounge surface that shows
// when an appointment happens. All functions are pinned to the
// clinic's timezone (Europe/London) so a UK booking always reads
// the same — "10:00 BST" — whether the viewer is in the UK or in
// Egypt. Without this, native toLocale* calls fall back to the
// device's local timezone and silently convert UK appointments to
// Cairo time on the lab team's screens, which is exactly the kind
// of cross-team-confusion bug we're trying to design out.
//
// Single source of truth — pure functions, no React. Strings here
// are also safe to pipe into email templates / Twilio SMS where
// any time we mention should always read in clinic time too.

// The clinic's wall-clock timezone. Hardcoded today because every
// Lounge location lives in the UK; when a non-UK clinic opens this
// becomes a per-location field and these helpers take a `timeZone`
// argument. Keep the constant centralised so that change is a one-
// file ripple, not a hunt across components.
export const CLINIC_TZ = 'Europe/London';

// IANA → human abbreviation the way clinic staff read it. Asks the
// browser's tz database what the SHORT zone is at a given instant —
// that handles DST automatically (BST in summer, GMT in winter),
// and would handle EET/EEST cleanly if we ever ran a Cairo clinic.
// Some Chromium builds return "GMT+1" / "GMT+0" instead of the
// canonical abbreviation; the switch normalises those back to the
// names UK staff actually say out loud.
export function fmtTzAbbr(iso: string, timeZone: string = CLINIC_TZ): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const dtf = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'short' });
    const tzPart = dtf.formatToParts(d).find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (timeZone === 'Europe/London') {
      if (tzPart === 'GMT+1') return 'BST';
      if (tzPart === 'GMT' || tzPart === 'GMT+0') return 'GMT';
    }
    if (timeZone === 'Africa/Cairo') {
      if (tzPart === 'GMT+2') return 'EET';
      if (tzPart === 'GMT+3') return 'EEST';
    }
    return tzPart;
  } catch {
    return '';
  }
}

// "Friday 1st May 2026" — ordinal day plus full weekday + month +
// year, computed in clinic time so a late-evening booking near
// midnight doesn't render as the next day for staff in a timezone
// ahead of UK.
export function formatDateLongOrdinal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const parts = londonParts(d);
  const weekday = new Intl.DateTimeFormat('en-GB', { timeZone: CLINIC_TZ, weekday: 'long' }).format(d);
  const month = new Intl.DateTimeFormat('en-GB', { timeZone: CLINIC_TZ, month: 'long' }).format(d);
  return `${weekday} ${parts.day}${ordinalSuffix(parts.day)} ${month} ${parts.year}`;
}

export function ordinalSuffix(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

// "09:00 — 14:00 BST" 24-hour clock range in clinic time. Zone
// abbreviation lands once, at the end, so the range still reads as
// a single phrase rather than "09:00 BST — 14:00 BST". Empty string
// if either bound fails to parse — callers decide whether to render
// anything.
export function formatTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  return `${londonTime(s)} — ${londonTime(e)} ${fmtTzAbbr(startIso)}`;
}

// "09:00 BST" — clinic-time single time with the BST/GMT suffix.
// The suffix is the whole point: a staff member in Egypt opening
// this booking sees "09:00 BST" and knows the patient is arriving
// at the UK clinic at 09:00 UK time, not 11:00 Cairo time.
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${londonTime(d)} ${fmtTzAbbr(iso)}`;
}

// "09:00" — clinic-time single time WITHOUT the zone suffix. Use
// only for layouts that render the zone elsewhere on the same row
// (e.g. a column header reading "Time (BST)") so we don't double-
// label it. Most callers want formatTime() above.
export function formatTimeNoZone(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return londonTime(d);
}

// Day-relative phrase for booked appointments. "Today" / "Tomorrow" /
// "In 5 days" / "Yesterday" / "5 days ago". Day boundaries are
// computed in clinic time, so a 23:00 BST appointment never reads
// as "Tomorrow" to a UK receptionist whose own clock has tipped
// past midnight in a different zone (or to an Egypt-based viewer
// whose local day has already rolled over). Returns null past a
// 30-day window in either direction so far dates fall back to the
// absolute label rather than reading as relative ("In 78 days" is
// noise, not insight).
export function relativeDay(iso: string): string | null {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  const days = londonDayDelta(target, new Date());
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days <= 30) return `In ${days} days`;
  if (days < -1 && days >= -30) return `${Math.abs(days)} days ago`;
  return null;
}

// ── Internal: clinic-time primitives ─────────────────────────────

// Wall-clock time string in clinic time, no zone suffix. e.g. "09:00".
function londonTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: CLINIC_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
}

// Numeric day / month / year in clinic time. Used by the date
// formatter to keep ordinal-day calculation independent of the
// browser timezone.
function londonParts(d: Date): { year: number; month: number; day: number } {
  const dtf = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLINIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = dtf.formatToParts(d);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day') };
}

// Whole-day difference between `target` and `today`, both viewed as
// clinic-time wall dates. Positive = target is in the future.
function londonDayDelta(target: Date, today: Date): number {
  const t = londonParts(target);
  const n = londonParts(today);
  const tEpoch = Date.UTC(t.year, t.month - 1, t.day);
  const nEpoch = Date.UTC(n.year, n.month - 1, n.day);
  return Math.round((tEpoch - nEpoch) / 86_400_000);
}

// Minute-resolution relative phrase for events that just happened.
// "Just now" / "5 minutes ago" / "23 minutes ago" / "2 hours ago".
// Used by the visit "When" ribbon to render "Arrived 23 minutes ago"
// and similar live-state lines. Falls through to the day-resolution
// helper for anything older than 24 hours.
export function relativeMinutes(iso: string): string | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const diffMs = Date.now() - t;
  // Negative diff = future event. Defer to the day-resolution
  // helper since "in 23 minutes" isn't a phrase the visit ribbon
  // would surface anyway (visits open at the moment of arrival).
  if (diffMs < 0) return relativeDay(iso);
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin === 1) return '1 minute ago';
  if (diffMin < 60) return `${diffMin} minutes ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr === 1) return '1 hour ago';
  if (diffHr < 24) return `${diffHr} hours ago`;
  return relativeDay(iso);
}
