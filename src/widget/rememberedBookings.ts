import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.ts';
import type { ManagedBooking } from './manage.ts';

// Patient-side recall of booking-management tokens.
//
// When a patient books from the widget, the edge function returns
// the new appointment's manage_token. We stash that locally so the
// next time the patient comes back from the same device the widget
// can offer "you have an upcoming booking — manage it?" before
// dropping them into a fresh booking flow.
//
// What's stored: only manage_tokens (uuid strings). The lookup RPC
// translates those into the safe patient-visible shape on demand,
// so localStorage never holds PII or any leakable detail.
//
// Cap to 10 most-recent tokens to keep localStorage tidy and the
// startup fan-out modest. Older tokens implicitly expire when the
// appointment passes — the lookup hook below prunes those on
// arrival, so the list self-cleans.
//
// localStorage can throw in Safari private mode / inside some
// iframes; every call wraps in try/catch and degrades to "no
// remembered tokens" rather than blowing up the widget shell.

const STORAGE_KEY = 'lng.widget.bookings';
const MAX_TOKENS = 10;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function loadRememberedBookings(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((t): t is string => typeof t === 'string' && UUID_RE.test(t));
  } catch {
    return [];
  }
}

function persist(tokens: string[]): void {
  try {
    const trimmed = tokens.slice(0, MAX_TOKENS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    // localStorage quota / private mode — non-fatal.
  }
}

/** Add a token (the most recent one goes to the front). De-dupes
 *  on identical strings so a re-booking with the same token
 *  doesn't duplicate. */
export function rememberBookingToken(token: string): void {
  if (!UUID_RE.test(token)) return;
  const cur = loadRememberedBookings();
  persist([token, ...cur.filter((t) => t !== token)]);
}

/** Drop a token. Used after cancel so the welcome screen doesn't
 *  pretend the booking still exists. */
export function forgetBookingToken(token: string): void {
  if (!token) return;
  persist(loadRememberedBookings().filter((t) => t !== token));
}

/** Replace one token with another in-place — for reschedule, where
 *  the old appointment row gets a new sibling and a new token. The
 *  position in the list is preserved so the welcome screen ordering
 *  stays roughly chronological-by-booking-time. */
export function replaceBookingToken(oldToken: string, newToken: string): void {
  if (!UUID_RE.test(newToken)) return;
  const cur = loadRememberedBookings();
  const idx = cur.indexOf(oldToken);
  if (idx === -1) {
    rememberBookingToken(newToken);
    return;
  }
  const next = [...cur];
  next[idx] = newToken;
  persist(next);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup hook
// ─────────────────────────────────────────────────────────────────────────────

export interface RememberedBooking extends ManagedBooking {
  /** The localStorage token the booking was looked up by, so the
   *  Manage link in the welcome screen can deep-link back to the
   *  same row. */
  token: string;
}

interface RememberedBookingsResult {
  data: RememberedBooking[];
  loading: boolean;
}

/** Resolves every remembered token to its current booking shape via
 *  the lookup RPC. Filters to upcoming-active bookings (status
 *  'booked' AND start_at in the future). Prunes tokens that no
 *  longer resolve (deleted appointments, garbage, etc.) and tokens
 *  whose appointment has passed or been cancelled / rescheduled —
 *  the welcome screen would only ever clutter with those. */
export function useRememberedBookings(): RememberedBookingsResult {
  const [data, setData] = useState<RememberedBooking[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const tokens = loadRememberedBookings();
      if (tokens.length === 0) {
        setData([]);
        setLoading(false);
        return;
      }

      // Fan out — one lookup RPC call per stored token. Capped at 10.
      const lookups = await Promise.all(
        tokens.map(async (token) => {
          const { data: rows } = await supabase.rpc('lng_widget_lookup_booking', {
            p_token: token,
          });
          const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
          return { token, row };
        }),
      );
      if (cancelled) return;

      const now = Date.now();
      const active: RememberedBooking[] = [];
      const deadTokens: string[] = [];
      for (const { token, row } of lookups) {
        if (!row) {
          deadTokens.push(token);
          continue;
        }
        const r = row as Record<string, unknown>;
        const status = (r.status as string) ?? '';
        const startAt = (r.start_at as string) ?? '';
        const isFuture = startAt ? new Date(startAt).getTime() > now : false;
        const isActive = status === 'booked' && isFuture;
        if (!isActive) {
          deadTokens.push(token);
          continue;
        }
        active.push({
          token,
          appointmentRef: (r.appointment_ref as string | null) ?? null,
          status,
          serviceType: (r.service_type as string | null) ?? null,
          serviceLabel: (r.service_label as string) ?? '',
          startAt,
          endAt: (r.end_at as string) ?? '',
          locationId: (r.location_id as string | null) ?? null,
          locationName: (r.location_name as string) ?? '',
          locationAddress: (r.location_address as string) ?? '',
          patientFirstName: (r.patient_first_name as string | null) ?? null,
          depositStatus: (r.deposit_status as string | null) ?? null,
          depositPence: (r.deposit_pence as number | null) ?? null,
          depositCurrency: (r.deposit_currency as string | null) ?? null,
          repairVariant: (r.repair_variant as string | null) ?? null,
          productKey: (r.product_key as string | null) ?? null,
          arch: (r.arch as 'upper' | 'lower' | 'both' | null) ?? null,
          cancellable: Boolean(r.cancellable),
        });
      }

      // Prune the dead tokens out of localStorage so the next mount
      // doesn't refetch them.
      if (deadTokens.length > 0) {
        const remaining = loadRememberedBookings().filter((t) => !deadTokens.includes(t));
        persist(remaining);
      }

      // Order by start time ascending — the soonest booking shows
      // first, which is what a returning patient wants to see.
      active.sort((a, b) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime());

      setData(active);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading };
}
