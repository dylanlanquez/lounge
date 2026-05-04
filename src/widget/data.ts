// Booking-widget data layer.
//
// Booking types come live from the public `lng_widget_booking_types`
// view; products + per-arch prices come from `lng_widget_catalogue`.
// Locations are still hard-coded for the single-clinic footprint
// and slots are stub-generated (phase 2c will land a server-side
// resolver that respects existing appointments + opening hours).
//
// Dentist selection isn't a customer-facing concept — the practice
// assigns staff internally based on availability. No dentist step
// in the widget; previous prototype removed.

export interface WidgetLocation {
  id: string;
  name: string;
  addressLine: string; // joined "138 Main Street, Glasgow, G1 2QA"
}

export interface WidgetBookingType {
  id: string;
  /** The closed-enum service identifier ('click_in_veneers',
   *  'denture_repair', 'same_day_appliance', etc). Drives the axis
   *  registry — see SERVICE_AXES in lib/queries/bookingTypeAxes.ts. */
  serviceType: string;
  /** Display label, sourced from `lng_booking_type_config.display_label`.
   *  No widget-specific override — the staff app and widget show the
   *  same name for the same service. */
  label: string;
  description: string;
  /** Deposit captured at booking time, in pence. 0 means no payment
   *  step. Widget-specific; sourced from
   *  lng_booking_type_config.widget_deposit_pence. */
  depositPence: number;
  /** Default appointment length. Phase 2c will resolve this to the
   *  most-specific lng_booking_type_config row once axes are pinned. */
  durationMinutes: number;
}

// Locations stay static for phase 2a; they'll move to a live read
// once we add multi-location support. The default Lounge clinic is
// fine to hardcode while the app is single-location.
export const WIDGET_LOCATIONS: WidgetLocation[] = [
  {
    id: 'loc-1',
    name: 'Venneir Lounge',
    addressLine: '138 Main Street, Glasgow, G1 2QA',
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Live booking-type read
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.ts';

interface BookingTypeReadResult {
  data: WidgetBookingType[] | null;
  loading: boolean;
  error: string | null;
}

/** Reads the public `lng_widget_booking_types` view. The view
 *  exposes only widget-visible parent rows, anon-readable, so this
 *  works without the patient signing in. Single-fire on mount,
 *  no real-time. */
export function useWidgetBookingTypes(): BookingTypeReadResult {
  const [data, setData] = useState<WidgetBookingType[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_widget_booking_types')
        .select('id, service_type, label, description, deposit_pence, duration_minutes')
        .order('label', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const shaped: WidgetBookingType[] = (rows ?? []).map((r) => ({
        id: r.id as string,
        serviceType: (r.service_type as string) ?? '',
        label: (r.label as string) ?? '',
        description: (r.description as string) ?? '',
        depositPence: (r.deposit_pence as number) ?? 0,
        durationMinutes: (r.duration_minutes as number) ?? 30,
      }));
      setData(shaped);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slot generator — v1 stub
// ─────────────────────────────────────────────────────────────────────────────
//
// Given a date, returns the slots a patient could pick. Phase 2
// replaces this with a server resolver that queries existing
// `lng_appointments` for conflicts and respects `clinic.opening_hours`
// from `lng_settings`. For now the stub is good enough to drive the
// UI: 9am–6pm weekdays, 10am–4pm Saturday, closed Sunday, in
// 15-minute increments. Lunch hour (1–2pm) is removed. Slots are
// further filtered by the booking type's duration so a 90-minute
// service doesn't show a 5:30pm option.

export interface WidgetSlot {
  /** ISO 8601 start time, local clinic timezone. */
  iso: string;
  /** Display string, e.g. "9:45 am". */
  label: string;
  /** Bucket the slot lands in for grouped display. */
  bucket: 'morning' | 'afternoon' | 'evening';
}

export function generateSlots(date: Date, durationMinutes: number): WidgetSlot[] {
  const dow = date.getDay(); // 0 Sun, 1 Mon, ..., 6 Sat
  if (dow === 0) return [];
  const isSaturday = dow === 6;
  const openHour = isSaturday ? 10 : 9;
  const closeHour = isSaturday ? 16 : 18;
  const stepMinutes = 15;
  const slots: WidgetSlot[] = [];
  for (let hour = openHour; hour < closeHour; hour++) {
    for (let minute = 0; minute < 60; minute += stepMinutes) {
      // Skip the 1pm-2pm lunch hour for non-Saturday.
      if (!isSaturday && hour === 13) continue;
      // Slot must finish before close.
      const minutesAfterOpen = (hour - openHour) * 60 + minute;
      const endMinutes = minutesAfterOpen + durationMinutes;
      const totalOpenMinutes = (closeHour - openHour) * 60 - (isSaturday ? 0 : 60);
      if (endMinutes > totalOpenMinutes) continue;

      const slotDate = new Date(date);
      slotDate.setHours(hour, minute, 0, 0);
      const iso = slotDate.toISOString();

      const period = hour < 12 ? 'am' : 'pm';
      const displayHour = hour <= 12 ? hour : hour - 12;
      const label = `${displayHour}:${String(minute).padStart(2, '0')} ${period}`;

      const bucket: WidgetSlot['bucket'] =
        hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';

      slots.push({ iso, label, bucket });
    }
  }
  return slots;
}

/** First future date that has at least one slot for the given
 *  booking-type duration. Used to power the "Our first availability"
 *  banner. */
export function firstAvailable(
  durationMinutes: number,
  from: Date = new Date(),
): { date: Date; slot: WidgetSlot } | null {
  for (let i = 0; i < 60; i++) {
    const d = new Date(from);
    d.setDate(d.getDate() + i);
    d.setHours(0, 0, 0, 0);
    const slots = generateSlots(d, durationMinutes);
    if (slots.length > 0) return { date: d, slot: slots[0]! };
  }
  return null;
}
