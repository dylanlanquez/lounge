// Booking-widget demo data.
//
// Phase 1 of the widget runs end-to-end against this in-file dataset
// so the visual flow + conditional step engine can be exercised
// without touching Supabase. Each booking type carries the metadata
// the step engine needs to decide how the flow branches:
//
//   • deposit_pence > 0   → adds Step 6 (Payment)
//   • allow_staff_pick    → adds Step 3 (Dentist)
//
// Phase 2 swaps these arrays out for live reads:
//
//   • locations     → public.locations (RLS already off)
//   • bookingTypes  → public.lng_booking_type_config + a new
//                     widget_visible / widget_price_pence /
//                     widget_deposit_pence column set
//   • dentists      → public.accounts filtered by location +
//                     active staff. Anon-read policy needed.
//   • slots         → server-side resolver that respects
//                     existing appointments + opening hours.
//
// Until then this file is the single source of truth for what the
// widget shows. Edit it freely while iterating on the design.

export interface WidgetLocation {
  id: string;
  name: string;
  addressLine: string; // joined "138 Main Street, Glasgow, G1 2QA"
}

export interface WidgetBookingType {
  id: string;
  label: string;
  description: string;
  pricePence: number;
  /** Pence required up-front. 0 means no deposit step. */
  depositPence: number;
  /** Whether the patient picks a specific dentist. False routes
   *  every booking of this type to "any available". */
  allowStaffPick: boolean;
  /** Default appointment length, used for slot generation in v1. */
  durationMinutes: number;
}

export interface WidgetDentist {
  id: string;
  name: string;
  /** Title shown under the name on the picker — "Principal dentist",
   *  "Hygienist", etc. Empty hides the line. */
  role: string;
  /** Public photo URL. Falls back to initials when empty. */
  avatarUrl: string;
}

export const WIDGET_LOCATIONS: WidgetLocation[] = [
  {
    id: 'loc-1',
    name: 'Venneir Lounge',
    addressLine: '138 Main Street, Glasgow, G1 2QA',
  },
];

export const WIDGET_BOOKING_TYPES: WidgetBookingType[] = [
  {
    id: 'bt-consultation',
    label: 'Consultation',
    description:
      'A 30-minute chat with one of our dentists. We assess what you need, talk through options, and book the right treatment from there. No commitment.',
    pricePence: 0,
    depositPence: 0,
    allowStaffPick: false,
    durationMinutes: 30,
  },
  {
    id: 'bt-cleaning',
    label: 'Cleaning &amp; polish',
    description:
      'Scale and polish with one of our hygienists. Removes plaque and surface stains, brightens the smile, and keeps the gums healthy.',
    pricePence: 5000,
    depositPence: 0,
    allowStaffPick: false,
    durationMinutes: 30,
  },
  {
    id: 'bt-whitening',
    label: 'Tooth whitening',
    description:
      'Custom-tray home-whitening kit. We take impressions, fit your trays, and provide the gel. Most patients see results within two weeks.',
    pricePence: 32000,
    depositPence: 5000,
    allowStaffPick: true,
    durationMinutes: 45,
  },
  {
    id: 'bt-veneers',
    label: 'Click-in veneers',
    description:
      'Removable, life-like veneers, designed and made in-house in a single visit. Same-day fit. We take impressions, design your smile with you, and you walk out wearing them.',
    pricePence: 195000,
    depositPence: 25000,
    allowStaffPick: true,
    durationMinutes: 90,
  },
  {
    id: 'bt-implant-consult',
    label: 'Implant consultation',
    description:
      'Detailed assessment with our implant lead, including a CT scan if needed. We talk through the plan, the timeline and the costs in plain English.',
    pricePence: 7500,
    depositPence: 2500,
    allowStaffPick: true,
    durationMinutes: 45,
  },
];

export const WIDGET_DENTISTS: WidgetDentist[] = [
  {
    id: 'dr-1',
    name: 'Dr Sarah Mackay',
    role: 'Principal dentist',
    avatarUrl: '',
  },
  {
    id: 'dr-2',
    name: 'Dr James Lin',
    role: 'Cosmetic &amp; restorative',
    avatarUrl: '',
  },
  {
    id: 'dr-3',
    name: 'Dr Aisha Patel',
    role: 'Implant lead',
    avatarUrl: '',
  },
  {
    id: 'hyg-1',
    name: 'Erin Walsh',
    role: 'Hygienist',
    avatarUrl: '',
  },
];

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
