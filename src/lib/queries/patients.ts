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
  lwo_ref: string | null;
  shopify_customer_id: string | null;
}

interface SearchResult {
  data: PatientRow[];
  loading: boolean;
  error: string | null;
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
        const filters: string[] = [
          `last_name.ilike.%${escape(cleaned)}%`,
          `first_name.ilike.%${escape(cleaned)}%`,
          `email.ilike.%${escape(cleaned)}%`,
          `internal_ref.ilike.%${escape(cleaned)}%`,
          `lwo_ref.ilike.%${escape(cleaned)}%`,
        ];
        if (phoneDigits.length >= 4) {
          filters.push(`phone.ilike.%${escape(phoneDigits)}%`);
        }
        const { data: rows, error: err } = await supabase
          .from('patients')
          .select(
            'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id'
          )
          .or(filters.join(','))
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
      'id, location_id, internal_ref, first_name, last_name, email, phone, date_of_birth, lwo_ref, shopify_customer_id'
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

export function patientShortName(p: Pick<PatientRow, 'first_name' | 'last_name'>): string {
  const last = (p.last_name || '').trim();
  return `${p.first_name} ${last ? last[0] + '.' : ''}`.trim();
}
