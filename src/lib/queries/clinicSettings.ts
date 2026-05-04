import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Clinic / branding settings stored in lng_settings under three
// prefixes: email.* (sender + branding), clinic.* (public contact
// fields and opening hours), legal.* (Companies House info). The
// migration in 20260504000005_lng_branding_clinic_settings.sql
// seeds the global defaults; this hook reads them and offers a
// single saveKey() to write back.
//
// All keys here are global (location_id IS NULL). Per-location
// override is plumbed end-to-end at the table level (lng_settings
// has location_id) but the admin UI is single-location for now.

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** A single day's opening times. `closed: true` means the clinic is
 *  shut that day; otherwise the day has open + close times in 24h
 *  HH:mm format (no timezone — assumed local). */
export type OpeningHoursDay =
  | { closed: true; open?: undefined; close?: undefined }
  | { closed?: false; open: string; close: string };

/** Mon=0 .. Sun=6, exactly seven entries. */
export type OpeningHoursWeek = readonly [
  OpeningHoursDay,
  OpeningHoursDay,
  OpeningHoursDay,
  OpeningHoursDay,
  OpeningHoursDay,
  OpeningHoursDay,
  OpeningHoursDay,
];

export interface ClinicSettings {
  // Branding
  brandLogoUrl: string;
  brandLogoShow: boolean;
  brandLogoMaxWidth: number;
  brandAccentColor: string;
  // Email sender
  fromName: string;
  replyTo: string;
  // Clinic contact (location-level)
  publicEmail: string;
  websiteUrl: string;
  bookingUrl: string;
  mapUrl: string;
  openingHours: OpeningHoursWeek;
  // Legal
  companyNumber: string;
  vatNumber: string;
  registeredAddress: string;
}

const DEFAULT_OPENING: OpeningHoursWeek = [
  { open: '09:00', close: '18:00' },
  { open: '09:00', close: '18:00' },
  { open: '09:00', close: '18:00' },
  { open: '09:00', close: '18:00' },
  { open: '09:00', close: '18:00' },
  { open: '10:00', close: '16:00' },
  { closed: true },
];

const DEFAULTS: ClinicSettings = {
  brandLogoUrl: 'https://lounge.venneir.com/lounge-logo.png',
  brandLogoShow: true,
  brandLogoMaxWidth: 120,
  brandAccentColor: '#0E1414',
  fromName: 'Venneir Lounge',
  replyTo: '',
  publicEmail: '',
  websiteUrl: '',
  bookingUrl: '',
  mapUrl: '',
  openingHours: DEFAULT_OPENING,
  companyNumber: '',
  vatNumber: '',
  registeredAddress: '',
};

/** Storage key → ClinicSettings field name. Keep in lockstep with
 *  the migration. The reverse map (saveKey) writes back to the same
 *  row for partial updates without re-emitting the whole document. */
const KEY_MAP = {
  'email.brand_logo_url': 'brandLogoUrl',
  'email.brand_logo_show': 'brandLogoShow',
  'email.brand_logo_max_width': 'brandLogoMaxWidth',
  'email.brand_accent_color': 'brandAccentColor',
  'email.from_name': 'fromName',
  'email.reply_to': 'replyTo',
  'clinic.public_email': 'publicEmail',
  'clinic.website_url': 'websiteUrl',
  'clinic.booking_url': 'bookingUrl',
  'clinic.map_url': 'mapUrl',
  'clinic.opening_hours': 'openingHours',
  'legal.company_number': 'companyNumber',
  'legal.vat_number': 'vatNumber',
  'legal.registered_address': 'registeredAddress',
} as const satisfies Record<string, keyof ClinicSettings>;

type SettingsKey = keyof typeof KEY_MAP;

// ─────────────────────────────────────────────────────────────────────────────
// Read hook
// ─────────────────────────────────────────────────────────────────────────────

interface ReadResult {
  data: ClinicSettings;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useClinicSettings(): ReadResult {
  const [data, setData] = useState<ClinicSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data: rows, error: err } = await supabase
        .from('lng_settings')
        .select('key, value')
        .or('key.like.email.%,key.like.clinic.%,key.like.legal.%')
        .is('location_id', null);
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const next: ClinicSettings = { ...DEFAULTS };
      for (const row of rows ?? []) {
        const key = row.key as SettingsKey;
        const field = KEY_MAP[key];
        if (!field) continue;
        // jsonb scalar values come back already-parsed; arrays
        // and objects come back as nested JS values. Cast through
        // `unknown` because each field has its own type.
        (next as unknown as Record<string, unknown>)[field] = row.value as unknown;
      }
      setData(next);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);
  return { data, loading, error, refresh };
}

// ─────────────────────────────────────────────────────────────────────────────
// Write
// ─────────────────────────────────────────────────────────────────────────────

/** Save a single setting. Upserts on (key) where location_id IS NULL
 *  so re-saving an already-existing key updates it cleanly. The
 *  jsonb column accepts any JSON value — strings, numbers, booleans,
 *  arrays, objects — so we hand it the raw value. */
export async function saveClinicSetting<K extends keyof ClinicSettings>(
  field: K,
  value: ClinicSettings[K],
): Promise<void> {
  const storageKey = (Object.entries(KEY_MAP) as Array<[SettingsKey, keyof ClinicSettings]>).find(
    ([, f]) => f === field,
  )?.[0];
  if (!storageKey) throw new Error(`Unknown clinic setting field: ${String(field)}`);

  // Try update first (most edits hit existing rows). If no row was
  // updated, fall through to insert. Cleaner than an UPSERT here
  // because the unique index is partial (location_id IS NULL) and
  // PostgREST's upsert helper doesn't play nicely with partials.
  const { data: updated, error: updErr } = await supabase
    .from('lng_settings')
    .update({ value: value as unknown as never })
    .eq('key', storageKey)
    .is('location_id', null)
    .select('id');
  if (updErr) throw new Error(`Couldn't save ${storageKey}: ${updErr.message}`);
  if (updated && updated.length > 0) return;

  const { error: insErr } = await supabase
    .from('lng_settings')
    .insert({ location_id: null, key: storageKey, value: value as unknown as never });
  if (insErr) throw new Error(`Couldn't insert ${storageKey}: ${insErr.message}`);
}
