// Shared date helpers for the AppointmentDetail and VisitDetail
// "When" ribbons. Pure functions so the two surfaces render identical
// strings — receptionists see a consistent date format ("Monday 8th
// June 2026") regardless of which page they're on.

// "Friday 1st May 2026" — ordinal day plus full weekday + month +
// year. Reads like a person says it aloud.
export function formatDateLongOrdinal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const weekday = d.toLocaleDateString('en-GB', { weekday: 'long' });
  const day = d.getDate();
  const month = d.toLocaleDateString('en-GB', { month: 'long' });
  const year = d.getFullYear();
  return `${weekday} ${day}${ordinalSuffix(day)} ${month} ${year}`;
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

// "09:00 — 14:00" 24-hour clock range. Empty string if either bound
// fails to parse — the caller decides whether to render anything.
export function formatTimeRange(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return '';
  const fmt = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${fmt(s)} — ${fmt(e)}`;
}

// "09:00" 24-hour clock single time. Empty string if parse fails.
export function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

// Day-relative phrase for booked appointments. "Today" / "Tomorrow" /
// "In 5 days" / "Yesterday" / "5 days ago". Returns null past a
// 30-day window in either direction so far dates fall back to the
// absolute label rather than reading as relative ("In 78 days" is
// noise, not insight).
export function relativeDay(iso: string): string | null {
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  const now = new Date();
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days > 1 && days <= 30) return `In ${days} days`;
  if (days < -1 && days >= -30) return `${Math.abs(days)} days ago`;
  return null;
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
