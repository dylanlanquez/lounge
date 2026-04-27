import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

export interface BnplStep {
  id: number;
  text: string;
}
export interface BnplTroubleshoot {
  row: string;
  says: string;
}
export interface BnplFaq {
  q: string;
  a: string;
}
export interface BnplPreflight {
  text: string;
  yes_label: string;
  no_label: string;
  no_followup: string;
}

export interface BnplScripts {
  klarna: {
    preflight: BnplPreflight | null;
    steps: BnplStep[];
    troubleshoot: BnplTroubleshoot[];
    faq: BnplFaq[];
  };
  clearpay: {
    preflight: BnplPreflight | null;
    steps: BnplStep[];
    troubleshoot: BnplTroubleshoot[];
    faq: BnplFaq[];
  };
  neverSay: string[];
}

const empty: BnplScripts = {
  klarna: { preflight: null, steps: [], troubleshoot: [], faq: [] },
  clearpay: { preflight: null, steps: [], troubleshoot: [], faq: [] },
  neverSay: [],
};

export function useBnplScripts(): { data: BnplScripts; loading: boolean; error: string | null } {
  const [data, setData] = useState<BnplScripts>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: rows, error: err } = await supabase
        .from('lng_settings')
        .select('key, value')
        .like('key', 'bnpl.%');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const map = new Map<string, unknown>();
      (rows ?? []).forEach((r) => map.set(r.key as string, r.value));
      setData({
        klarna: {
          preflight: (map.get('bnpl.klarna.preflight') as BnplPreflight | null) ?? null,
          steps: (map.get('bnpl.klarna.steps') as BnplStep[]) ?? [],
          troubleshoot: (map.get('bnpl.klarna.troubleshoot') as BnplTroubleshoot[]) ?? [],
          faq: (map.get('bnpl.klarna.faq') as BnplFaq[]) ?? [],
        },
        clearpay: {
          preflight: (map.get('bnpl.clearpay.preflight') as BnplPreflight | null) ?? null,
          steps: (map.get('bnpl.clearpay.steps') as BnplStep[]) ?? [],
          troubleshoot: (map.get('bnpl.clearpay.troubleshoot') as BnplTroubleshoot[]) ?? [],
          faq: (map.get('bnpl.clearpay.faq') as BnplFaq[]) ?? [],
        },
        neverSay: (map.get('bnpl.never_say') as string[]) ?? [],
      });
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { data, loading, error };
}
