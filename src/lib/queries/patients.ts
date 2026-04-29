import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!opts.enabled) {
      setData([]);
      setLoading(false);
      setError(null);
      return;
    }
    const cleaned = term.trim();
    if (cleaned.length < 3) {
      setData([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
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
          setLoading(false);
          return;
        }
        if (!res?.ok) {
          setError(res?.detail ?? res?.error ?? 'shopify_search_failed');
          setData([]);
          setLoading(false);
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
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setData([]);
        setLoading(false);
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, opts.enabled]);

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
  if (error) throw new Error(error.message);
  if (!data?.ok) {
    throw new Error(data?.detail ?? data?.error ?? 'update_failed');
  }
  return {
    identitySynced: !!data.identity_synced,
    fieldsChanged: Array.isArray(data.fields_changed) ? data.fields_changed : [],
  };
}

// Phone-first search per `06-patient-identity.md §4.1`. Term can be a phone
// number, name, or LWO ref. ILIKE matches each, LIMIT 10.

export function usePatientSearch(term: string): SearchResult {
  const [data, setData] = useState<PatientRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const cleaned = term.trim();
    if (cleaned.length < 2) {
      setData([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const phoneDigits = cleaned.replace(/\D/g, '');
        const isPhoneSearch =
          phoneDigits.length >= 7 &&
          phoneDigits.length <= 15 &&
          /^[\d\s+()\-]+$/.test(cleaned);
        const words = cleaned.split(/\s+/).filter(Boolean);

        let query = supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id'
          );

        if (isPhoneSearch) {
          // The whole term is a phone — search the phone column with
          // the digits collapsed.
          query = query.ilike('phone', `%${phoneDigits}%`);
        } else if (words.length > 1) {
          // Multi-word term like "dylan lane" — no single column will
          // contain the full phrase, so split into words and require
          // each one to match at least one of the name / email / ref
          // columns. Each chained .or() adds an AND-group at the top
          // level (PostgREST treats sibling logical filters as AND).
          for (const word of words) {
            const w = escape(word);
            query = query.or(
              `first_name.ilike.%${w}%,last_name.ilike.%${w}%,email.ilike.%${w}%,internal_ref.ilike.%${w}%`
            );
          }
        } else {
          // Single token — OR across columns, including a phone-
          // fragment match when there are enough digits (handles
          // partial dial-pad searches like "0770").
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
          query = query.or(filters.join(','));
        }

        const { data: rows, error: err } = await query
          .order('last_name', { ascending: true })
          .limit(10);
        if (cancelled) return;
        if (err) {
          setError(err.message);
          setLoading(false);
          return;
        }
        setData((rows ?? []) as PatientRow[]);
        setError(null);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setLoading(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

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

export function patientFullName(p: Pick<PatientRow, 'first_name' | 'last_name'>): string {
  return `${p.first_name} ${p.last_name}`.trim();
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const cleaned = term.trim();
    const timer = setTimeout(async () => {
      try {
        const startIdx = page * limit;
        // PostgREST .range is inclusive on both ends. Fetching one
        // extra row tells us whether a next page exists.
        const endIdx = startIdx + limit; // limit + 1 rows total
        let q = supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id, registered_at'
          )
          .order('first_name', { ascending: true })
          .order('last_name', { ascending: true })
          .range(startIdx, endIdx);

        if (cleaned.length >= 2) {
          const phoneDigits = cleaned.replace(/\D/g, '');
          const filters: string[] = [
            `last_name.ilike.%${escape(cleaned)}%`,
            `first_name.ilike.%${escape(cleaned)}%`,
            `email.ilike.%${escape(cleaned)}%`,
            `internal_ref.ilike.%${escape(cleaned)}%`,
            ];
          if (phoneDigits.length >= 4) {
            filters.push(`phone.ilike.%${escape(phoneDigits)}%`);
          }
          q = q.or(filters.join(','));
        }

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
              setLoading(false);
              return;
            }
            const fb = (fallback ?? []) as Array<PatientRow>;
            setHasMore(fb.length > limit);
            setData(
              fb.slice(0, limit).map((p) => ({ ...p, registered_at: null, last_visit_at: null }))
            );
            setError(null);
            setLoading(false);
            return;
          }
          setError(err.message);
          setLoading(false);
          return;
        }
        const list = (rows ?? []) as Array<PatientRow & { registered_at: string | null }>;
        setHasMore(list.length > limit);
        setData(
          list.slice(0, limit).map((p) => ({
            ...p,
            registered_at: p.registered_at ?? null,
            last_visit_at: null,
          }))
        );
        setError(null);
        setLoading(false);
      } catch (e: unknown) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Unknown error');
        setLoading(false);
      }
    }, 220);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term, page, limit]);

  return { data, loading, error, hasMore };
}

function buildFallback(term: string) {
  const phoneDigits = term.replace(/\D/g, '');
  const filters: string[] = [
    `last_name.ilike.%${escape(term)}%`,
    `first_name.ilike.%${escape(term)}%`,
    `email.ilike.%${escape(term)}%`,
    `internal_ref.ilike.%${escape(term)}%`,
  ];
  if (phoneDigits.length >= 4) {
    filters.push(`phone.ilike.%${escape(phoneDigits)}%`);
  }
  return supabase
    .from('patients')
    .select('id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, shopify_customer_id')
    .or(filters.join(','))
    .order('first_name', { ascending: true })
    .order('last_name', { ascending: true });
}

export function patientShortName(p: Pick<PatientRow, 'first_name' | 'last_name'>): string {
  const last = (p.last_name || '').trim();
  return `${p.first_name} ${last ? last[0] + '.' : ''}`.trim();
}
