import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { properCase } from './appointments.ts';
import { useStaleQueryLoading } from '../useStaleQueryLoading.ts';

export interface PatientRow {
  id: string;
  location_id: string;
  internal_ref: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  date_of_birth: string | null;
  shopify_customer_id: string | null;
}

interface SearchResult {
  data: PatientRow[];
  loading: boolean;
  error: string | null;
}

// Shopify customer (no patient row yet) result shape returned by the
// shopify-customer-search edge function. Used by the walk-in
// search-first flow to surface customers who exist on venneir.com but
// have not been registered as a patient at the lab.
export interface ShopifyCustomerResult {
  shopify_customer_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  orders_count: number;
}

interface ShopifySearchResult {
  data: ShopifyCustomerResult[];
  loading: boolean;
  error: string | null;
}

// Hits Shopify's customers query via the staff-authenticated edge
// function. Off by default — only enable from surfaces that actually
// want to register Shopify customers as patients (the walk-in flow).
// Returns an empty list when disabled, when the term is too short,
// or when the request fails (loud failures live on the server side).
export function useShopifyCustomerSearch(
  term: string,
  opts: { enabled: boolean }
): ShopifySearchResult {
  const [data, setData] = useState<ShopifyCustomerResult[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Search loading uses a constant key so typing keystrokes don't
  // flick the UI back to a skeleton — previous results stay visible
  // while the next request runs (stale-while-revalidate).
  const { loading, settle } = useStaleQueryLoading('shopify-search');

  useEffect(() => {
    if (!opts.enabled) {
      setData([]);
      settle();
      setError(null);
      return;
    }
    const cleaned = term.trim();
    if (cleaned.length < 3) {
      setData([]);
      settle();
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const { data: res, error: err } = await supabase.functions.invoke(
          'shopify-customer-search',
          { body: { query: cleaned } },
        );
        if (cancelled) return;
        if (err) {
          setError(err.message);
          setData([]);
          settle();
          return;
        }
        if (!res?.ok) {
          setError(res?.detail ?? res?.error ?? 'shopify_search_failed');
          setData([]);
          settle();
          return;
        }
        const customers: ShopifyCustomerResult[] = Array.isArray(res.customers)
          ? res.customers
          : [];
        // Shopify's customers(query:) treats space-separated words as
        // OR with prefix matching, so "james black" returns anyone
        // matching either word — Paul Lackerstein, Ksenia Placinska
        // and other unrelated rows leak through. Tighten with a
        // client-side AND filter: every word must appear in name +
        // email + phone (joined). Single-word terms skip the filter
        // so Shopify's fuzzy/prefix behaviour still helps with
        // partial matches.
        const words = cleaned
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 0);
        const filtered =
          words.length > 1
            ? customers.filter((c) => {
                const haystack = [
                  c.first_name ?? '',
                  c.last_name ?? '',
                  c.email ?? '',
                  c.phone ?? '',
                ]
                  .join(' ')
                  .toLowerCase();
                return words.every((w) => haystack.includes(w));
              })
            : customers;
        setData(filtered);
        setError(null);
        settle();
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setData([]);
        settle();
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, opts.enabled, settle]);

  return { data, loading, error };
}

// Calls staff-link-shopify-customer in REGISTER mode. Creates a fresh
// patient row pre-linked to the Shopify customer, with identity fields
// seeded from Shopify. Throws on failure so the caller surfaces a
// loud error in the UI.
export async function registerShopifyCustomerAsPatient(args: {
  shopifyCustomerId: string;
  locationId: string;
}): Promise<{ patientId: string }> {
  const { data, error } = await supabase.functions.invoke(
    'staff-link-shopify-customer',
    {
      body: {
        shopify_customer_id: args.shopifyCustomerId,
        location_id: args.locationId,
      },
    },
  );
  if (error) throw new Error(error.message);
  if (!data?.ok) {
    throw new Error(data?.detail ?? data?.error ?? 'register_failed');
  }
  const patientId = data?.patient_id;
  if (typeof patientId !== 'string' || !patientId) {
    throw new Error('register_returned_no_patient_id');
  }
  return { patientId };
}

// Calls staff-update-patient. Routes identity edits via Shopify Admin
// for linked patients, or directly to the patients row for walk-ins.
// Returns the response so the caller can read identity_synced and
// fields_changed for follow-up UI feedback.
export async function staffUpdatePatient(args: {
  patientId: string;
  identity?: {
    firstName?: string | null;
    lastName?: string | null;
    email?: string | null;
    phone?: string | null;
    address?: {
      company?: string | null;
      address1?: string | null;
      address2?: string | null;
      city?: string | null;
      province?: string | null;
      postcode?: string | null;
      countryCode?: string | null;
    } | null;
  };
  clinical?: {
    date_of_birth?: string | null;
    sex?: string | null;
    allergies?: string | null;
    emergency_contact_name?: string | null;
    emergency_contact_phone?: string | null;
    notes?: string | null;
    communication_preferences?: string | null;
  };
}): Promise<{ identitySynced: boolean; fieldsChanged: string[] }> {
  const { data, error } = await supabase.functions.invoke('staff-update-patient', {
    body: {
      patient_id: args.patientId,
      identity: args.identity,
      clinical: args.clinical,
    },
  });
  if (error) {
    // Transport-level failure (network, CORS, non-JSON response).
    // Log the full Supabase error object so devtools can show the
    // status code / response context the toast can't fit.
    // eslint-disable-next-line no-console
    console.error('[staff-update-patient] transport error', error);
    throw new Error(error.message);
  }
  if (!data?.ok) {
    // Application-level failure surfaced by the function as
    // { ok: false, error, detail, details? }. The function also
    // writes the same failure to lng_system_failures so an admin can
    // triage even after the toast is dismissed; logging the full
    // response here gives whichever dev opens devtools the same view.
    // eslint-disable-next-line no-console
    console.error('[staff-update-patient] update rejected', data);
    const err = new Error(data?.detail ?? data?.error ?? 'update_failed');
    // Attach the error_kind so the UI can offer a "show details" link
    // that points at the matching lng_system_failures row.
    (err as Error & { errorKind?: string }).errorKind =
      typeof data?.error === 'string' ? data.error : 'update_failed';
    throw err;
  }
  return {
    identitySynced: !!data.identity_synced,
    fieldsChanged: Array.isArray(data.fields_changed) ? data.fields_changed : [],
  };
}

// Apply phone-first / multi-word patient search filters to a Supabase
// query builder. Single source-of-truth shared between the picker
// (usePatientSearch) and the Patients page list (usePatientList) so a
// receptionist gets the same matching behaviour everywhere.
//
// Three modes:
//   1. Pure phone term ("07700 900123") → exact column match on
//      patients.phone with non-digits stripped.
//   2. Multi-word ("James DylanzasA") → tokenise on whitespace and
//      require EACH token to match at least one of first_name,
//      last_name, email, or internal_ref. Each chained .or() adds an
//      AND group at the top level (PostgREST treats sibling logical
//      filters as AND), so "James" pins first_name and "DylanzasA"
//      pins last_name in one query.
//   3. Single token → OR across name / email / internal_ref columns,
//      with a phone-fragment match when there are enough digits to
//      avoid noise (covers partial dial-pad searches like "0770").
//
// The function returns the chained builder so callers keep their own
// ordering / range / limit. Doing nothing when the term is empty
// keeps the no-search path (full list) intact.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPatientSearch<Q extends { ilike: any; or: any }>(
  query: Q,
  term: string,
): Q {
  const cleaned = term.trim();
  if (!cleaned) return query;
  const phoneDigits = cleaned.replace(/\D/g, '');
  const isPhoneSearch =
    phoneDigits.length >= 7 &&
    phoneDigits.length <= 15 &&
    /^[\d\s+()\-]+$/.test(cleaned);
  if (isPhoneSearch) {
    return query.ilike('phone', `%${phoneDigits}%`);
  }
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    let q = query;
    for (const word of words) {
      const w = escape(word);
      q = q.or(
        `first_name.ilike.%${w}%,last_name.ilike.%${w}%,email.ilike.%${w}%,internal_ref.ilike.%${w}%`,
      );
    }
    return q;
  }
  const w = escape(words[0]!);
  const filters: string[] = [
    `last_name.ilike.%${w}%`,
    `first_name.ilike.%${w}%`,
    `email.ilike.%${w}%`,
    `internal_ref.ilike.%${w}%`,
  ];
  if (phoneDigits.length >= 4) {
    filters.push(`phone.ilike.%${phoneDigits}%`);
  }
  return query.or(filters.join(','));
}

// Phone-first search per `06-patient-identity.md §4.1`. Term can be a phone
// number, name, or LWO ref. ILIKE matches each, LIMIT 10.

export function usePatientSearch(term: string): SearchResult {
  const [data, setData] = useState<PatientRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Constant key — typing keystrokes don't flick the UI to a
  // skeleton; the previous results stay visible while the next
  // request runs.
  const { loading, settle } = useStaleQueryLoading('patient-search');

  useEffect(() => {
    const cleaned = term.trim();
    if (cleaned.length < 2) {
      setData([]);
      settle();
      setError(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const baseQuery = supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id'
          );
        const query = applyPatientSearch(baseQuery, cleaned);

        const { data: rows, error: err } = await query
          .order('last_name', { ascending: true })
          .limit(10);
        if (cancelled) return;
        if (err) {
          setError(err.message);
          settle();
          return;
        }
        setData((rows ?? []) as PatientRow[]);
        setError(null);
        settle();
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        settle();
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, settle]);

  return { data, loading, error };
}

export async function getPatient(id: string): Promise<PatientRow | null> {
  const { data, error } = await supabase
    .from('patients')
    .select(
      'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id'
    )
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as PatientRow | null) ?? null;
}

// Lightweight escaping for the OR-filter syntax. The Supabase REST API parses
// commas inside ILIKE patterns; escape them to avoid splitting.
function escape(s: string): string {
  return s.replace(/,/g, '\\,').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

// Display-formatted full name. Source data arrives in mixed case
// (Shopify gives us lower-case email-derived names, lab imports
// shout in ALL CAPS, etc.) so every UI surface that shows a patient
// name should go through this helper rather than concatenating raw
// columns. properCase handles honorifics and apostrophes.
export function patientFullName(p: Pick<PatientRow, 'first_name' | 'last_name'>): string {
  return `${properCase(p.first_name)} ${properCase(p.last_name)}`.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// Full patient list — used by the Patients route's table. Phone-first
// search if a term is provided; otherwise pages through everyone in
// alphabetical order. The Lounge route is view-only, so no inserts /
// updates are exposed here.
// ─────────────────────────────────────────────────────────────────────────────

export interface PatientListRow extends PatientRow {
  registered_at: string | null;
  last_visit_at: string | null;
  // Meridian's avatar pointer (URL, data URL, or 'preset:…' /
  // 'logo:…' selector). Surfaced so Lounge's patient list
  // renders the patient's actual avatar instead of always
  // falling back to initials.
  avatar_data: string | null;
}

interface ListResult {
  data: PatientListRow[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
}

export const PATIENT_LIST_PAGE_SIZE = 50;

// Page-aware patient list. `page` is zero-indexed; page 0 returns the
// first 50 patients, page 1 the next 50, etc. The query fetches one
// extra row past the page boundary so the consumer can disable the
// Next button without a separate count query.
export function usePatientList(
  term: string,
  page: number = 0,
  limit: number = PATIENT_LIST_PAGE_SIZE
): ListResult {
  const [data, setData] = useState<PatientListRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Page is part of the key — flicking pages is a real resource
  // transition (different rows). Term is NOT in the key — typing
  // keystrokes preserve the previous page of results on screen
  // while the next request runs.
  const { loading, settle } = useStaleQueryLoading(`patient-list|${page}|${limit}`);

  useEffect(() => {
    let cancelled = false;
    const cleaned = term.trim();
    const timer = setTimeout(async () => {
      try {
        const startIdx = page * limit;
        // PostgREST .range is inclusive on both ends. Fetching one
        // extra row tells us whether a next page exists.
        const endIdx = startIdx + limit; // limit + 1 rows total
        const baseQuery = supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id, registered_at, avatar_data'
          );
        // applyPatientSearch is the single source of truth for how
        // patient text searches behave (multi-word AND-of-ORs, phone
        // detection, single-token OR). Sub-2-character terms produce
        // an unfiltered list — same posture as before this refactor.
        const filtered =
          cleaned.length >= 2 ? applyPatientSearch(baseQuery, cleaned) : baseQuery;
        const q = filtered
          .order('first_name', { ascending: true })
          .order('last_name', { ascending: true })
          .range(startIdx, endIdx);

        const { data: rows, error: err } = await q;
        if (cancelled) return;
        if (err) {
          // 42703: registered_at column missing on this Meridian
          // deploy. Retry without that column rather than crash.
          if (err.code === '42703') {
            const { data: fallback, error: err2 } = await (cleaned.length >= 2
              ? buildFallback(cleaned).range(startIdx, endIdx)
              : supabase
                  .from('patients')
                  .select('id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id')
                  .order('first_name', { ascending: true })
                  .order('last_name', { ascending: true })
                  .range(startIdx, endIdx));
            if (cancelled) return;
            if (err2) {
              setError(err2.message);
              settle();
              return;
            }
            const fb = (fallback ?? []) as Array<PatientRow & { avatar_data?: string | null }>;
            setHasMore(fb.length > limit);
            setData(
              fb
                .slice(0, limit)
                .map((p) => ({
                  ...p,
                  registered_at: null,
                  last_visit_at: null,
                  avatar_data: p.avatar_data ?? null,
                }))
            );
            setError(null);
            settle();
            return;
          }
          setError(err.message);
          settle();
          return;
        }
        const list = (rows ?? []) as Array<
          PatientRow & { registered_at: string | null; avatar_data: string | null }
        >;
        setHasMore(list.length > limit);
        setData(
          list.slice(0, limit).map((p) => ({
            ...p,
            registered_at: p.registered_at ?? null,
            last_visit_at: null,
            avatar_data: p.avatar_data ?? null,
          }))
        );
        setError(null);
        settle();
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        settle();
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, page, limit, settle]);

  return { data, loading, error, hasMore };
}

function buildFallback(term: string) {
  const baseQuery = supabase
    .from('patients')
    .select(
      'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id'
    );
  return applyPatientSearch(baseQuery, term)
    .order('first_name', { ascending: true })
    .order('last_name', { ascending: true });
}

export function patientShortName(p: Pick<PatientRow, 'first_name' | 'last_name'>): string {
  const last = (p.last_name || '').trim();
  return `${p.first_name} ${last ? last[0] + '.' : ''}`.trim();
}
