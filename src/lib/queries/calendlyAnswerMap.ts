import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface CalendlyAnswerMapRow {
  id: string;
  question: string;
  answer_text: string;
  catalogue_id: string;
  created_at: string;
  catalogue_name: string;
  catalogue_category: string;
}

export interface CalendlyDiscoveredAnswer {
  question: string;
  answer_text: string;
  frequency: number;
}

interface RawRow {
  id: string;
  question: string;
  answer_text: string;
  catalogue_id: string;
  created_at: string;
  catalogue: { name: string; category: string } | { name: string; category: string }[] | null;
}

// Stable Map key for a (question, answer) pair.
// Uses a null-byte separator that won't appear in real intake strings.
export function answerMapKey(question: string, answer: string): string {
  return `${question.toLowerCase().trim()}\x00${answer.toLowerCase().trim()}`;
}

export function useCalendlyAnswerMap(): {
  rows: CalendlyAnswerMapRow[];
  byQuestionAnswer: Map<string, CalendlyAnswerMapRow>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [rows, setRows] = useState<CalendlyAnswerMapRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('lng_calendly_answer_map')
        .select('id, question, answer_text, catalogue_id, created_at, catalogue:lwo_catalogue ( name, category )')
        .order('question')
        .order('answer_text');
      if (cancelled) return;
      if (err) {
        if (err.code === 'PGRST200' || err.code === '42P01') {
          setRows([]);
          setError(null);
        } else {
          setError(err.message);
        }
        setLoading(false);
        return;
      }
      const mapped = (data ?? []).map((r) => {
        const raw = r as unknown as RawRow;
        const cat = Array.isArray(raw.catalogue) ? raw.catalogue[0] : raw.catalogue;
        return {
          id: raw.id,
          question: raw.question,
          answer_text: raw.answer_text,
          catalogue_id: raw.catalogue_id,
          created_at: raw.created_at,
          catalogue_name: cat?.name ?? '',
          catalogue_category: cat?.category ?? '',
        };
      });
      setRows(mapped);
      setError(null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  const byQuestionAnswer = useMemo(
    () => new Map(rows.map((r) => [answerMapKey(r.question, r.answer_text), r])),
    [rows]
  );

  return { rows, byQuestionAnswer, loading, error, refresh };
}

export function useCalendlyDiscoveredAnswers(): {
  answers: CalendlyDiscoveredAnswer[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [answers, setAnswers] = useState<CalendlyDiscoveredAnswer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase.rpc('lng_distinct_calendly_answers');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setAnswers(
        (data ?? []).map((r: { question: string; answer_text: string; frequency: string | number }) => ({
          question: r.question,
          answer_text: r.answer_text,
          frequency: Number(r.frequency),
        }))
      );
      setError(null);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [tick]);

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  return { answers, loading, error, refresh };
}

// Upsert a (question, answer_text) → catalogue_id mapping.
// Uses an RPC because the unique index is expression-based and PostgREST
// can't resolve expression-index conflicts in client-side upserts.
export async function saveCalendlyAnswerMap(
  question: string,
  answer_text: string,
  catalogue_id: string
): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc('lng_upsert_calendly_answer', {
    p_question: question,
    p_answer_text: answer_text,
    p_catalogue_id: catalogue_id,
  });
  return { error: error?.message ?? null };
}

export async function deleteCalendlyAnswerMap(id: string): Promise<{ error: string | null }> {
  const { error } = await supabase.from('lng_calendly_answer_map').delete().eq('id', id);
  return { error: error?.message ?? null };
}
