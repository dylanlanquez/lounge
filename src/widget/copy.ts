import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase.ts';

// Booking-widget copy contract.
//
// Every patient-facing string the widget renders has a default
// shipped in code (DEFAULT_COPY) and an optional override stored
// in lng_settings under the key 'widget.copy'. The admin edits
// from Admin → Widget → Step copy; the widget reads the merged
// document via useWidgetCopy().
//
// Adding a new editable string is a four-step move:
//
//   1. Add the field to WidgetCopy + DEFAULT_COPY here.
//   2. Read the field from useWidgetCopy() in the widget component
//      that owns the rendering.
//   3. Add a labelled input row to the admin tab's Step copy section.
//   4. (Optional) Add a placeholder / helper hint in the admin row.
//
// Empty strings count as "use the default" — the merger falls back
// for any blank field, so the admin can never accidentally ship a
// completely missing label.

export interface WidgetCopy {
  // Step 1 — Location
  locationTitle: string;
  /** Greeting line shown above the location list when we have a
   *  remembered identity for this device. {name} is replaced with
   *  the patient's full name; "Not you?" follows automatically. */
  locationGreetingFormat: string;

  // Step 2 — Service
  serviceTitle: string;
  serviceHelper: string;

  // Axis steps — the per-axis questions read from the registry, but
  // the helper line under each question is editable.
  axisRepairVariantHelper: string;
  axisProductKeyHelper: string;
  axisArchHelper: string;

  // Step — Upgrades (Optional extras)
  upgradesTitle: string;
  upgradesHelper: string;
  /** Continue-button copy when no upgrade is selected. */
  upgradesContinueEmpty: string;
  /** Continue-button copy when one or more upgrades are selected.
   *  {n} is replaced with the count. */
  upgradesContinueWithFormat: string;

  // Step — Time
  timeTitle: string;
  /** Banner above the calendar pointing at the soonest opening. */
  timeFirstOpeningLabel: string;

  // Step — Details
  detailsTitle: string;
  detailsNotesLabel: string;
  detailsNotesPlaceholder: string;
  detailsRememberLabel: string;
  detailsTermsLabel: string;
  /** Where the "terms and conditions" link points. */
  detailsTermsUrl: string;

  // Step — Payment
  paymentTitle: string;
  paymentDisclaimer: string;

  // Confirmation screen
  successTitle: string;
  /** Body line shown under the success heading. {service}, {location}
   *  and {when} are replaced. */
  successBodyFormat: string;
  successFollowupFormat: string;

  // Summary panel
  summaryTitle: string;
  summaryTotalLabel: string;
  summaryPayLaterLabel: string;
  summaryCtaBook: string;
  summaryCtaPayment: string;

  // Footer
  footerPoweredBy: string;
}

export const DEFAULT_COPY: WidgetCopy = {
  locationTitle: 'Location',
  locationGreetingFormat: 'Welcome back, {name}.',

  serviceTitle: 'What you need',
  serviceHelper:
    "Pick the kind of appointment you'd like to book. We'll ask any follow-up details next.",

  axisRepairVariantHelper: "We'll match you to the right specialist.",
  axisProductKeyHelper:
    "Pick the option that fits — we'll confirm any details when you arrive.",
  axisArchHelper: 'The top teeth, the bottom teeth, or both. Pick whichever applies.',

  upgradesTitle: 'Optional extras',
  upgradesHelper:
    "Anything you'd like to add? Pick as many as you want, or none, then continue. You can always change your mind in clinic.",
  upgradesContinueEmpty: 'No extras, continue',
  upgradesContinueWithFormat: 'Continue with {n} extras',

  timeTitle: 'Date and time',
  timeFirstOpeningLabel: 'Our first opening',

  detailsTitle: 'Your details',
  detailsNotesLabel: 'Notes or comments (optional)',
  detailsNotesPlaceholder: 'Anything we should know about beforehand?',
  detailsRememberLabel:
    "Remember me on this device. Untick if you're on a public computer.",
  detailsTermsLabel: 'I agree to the {link}.',
  detailsTermsUrl: '/terms',

  paymentTitle: 'Payment',
  paymentDisclaimer:
    'Payments handled by Stripe. We never see or store your card number.',

  successTitle: "You're booked in",
  successBodyFormat: '{service} at {location}',
  successFollowupFormat:
    "A confirmation has gone to {email} with a calendar invite. We'll send a reminder a day before.",

  summaryTitle: 'Booking summary',
  summaryTotalLabel: 'Total today',
  summaryPayLaterLabel: 'Pay at appointment',
  summaryCtaBook: 'Book appointment',
  summaryCtaPayment: 'Continue to payment',

  footerPoweredBy: 'Powered by Lounge',
};

// ─────────────────────────────────────────────────────────────────────────────
// Read hook (widget side, anon)
// ─────────────────────────────────────────────────────────────────────────────

interface ReadResult {
  copy: WidgetCopy;
  loading: boolean;
  error: string | null;
}

/** Reads the override document from public.lng_widget_copy and
 *  merges it with DEFAULT_COPY. Empty strings in the override
 *  count as "use default" — the merge ignores them. */
export function useWidgetCopy(): ReadResult {
  const [copy, setCopy] = useState<WidgetCopy>(DEFAULT_COPY);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: err } = await supabase
        .from('lng_widget_copy')
        .select('copy')
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      const overrides = (data?.copy as Partial<WidgetCopy> | null) ?? null;
      setCopy(mergeCopy(overrides));
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { copy, loading, error };
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin-side read + write
// ─────────────────────────────────────────────────────────────────────────────

/** Admin-side read: returns the raw stored overrides (NOT merged
 *  with defaults), so the admin form shows empty fields for
 *  un-customised strings. The form's placeholders display the
 *  default so the admin sees what the empty state will render. */
export function useWidgetCopyOverrides(): {
  overrides: Partial<WidgetCopy>;
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [overrides, setOverrides] = useState<Partial<WidgetCopy>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const { data, error: err } = await supabase
        .from('lng_settings')
        .select('value')
        .eq('key', 'widget.copy')
        .is('location_id', null)
        .maybeSingle();
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setLoading(false);
        return;
      }
      setOverrides(((data?.value as Partial<WidgetCopy> | null) ?? {}) as Partial<WidgetCopy>);
      setError(null);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return {
    overrides,
    loading,
    error,
    refresh: () => setTick((t) => t + 1),
  };
}

/** Save the overrides document. Empty-string fields are stripped
 *  before the write so the document stays compact and the merger
 *  logic stays simple. */
export async function saveWidgetCopy(overrides: Partial<WidgetCopy>): Promise<void> {
  const stripped: Partial<WidgetCopy> = {};
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && value.trim() !== '') {
      (stripped as Record<string, string>)[key] = value;
    }
  }
  const { error: updErr, data: updated } = await supabase
    .from('lng_settings')
    .update({ value: stripped as unknown as never })
    .eq('key', 'widget.copy')
    .is('location_id', null)
    .select('id');
  if (updErr) throw new Error(`Couldn't save widget copy: ${updErr.message}`);
  if (updated && updated.length > 0) return;
  // Row didn't exist (migration not applied?) — insert as fallback.
  const { error: insErr } = await supabase
    .from('lng_settings')
    .insert({ location_id: null, key: 'widget.copy', value: stripped as unknown as never });
  if (insErr) throw new Error(`Couldn't insert widget copy: ${insErr.message}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Merges the stored override document with DEFAULT_COPY. Any
 *  override field that's missing or an empty string falls back to
 *  the default. */
function mergeCopy(overrides: Partial<WidgetCopy> | null): WidgetCopy {
  const out: WidgetCopy = { ...DEFAULT_COPY };
  if (!overrides) return out;
  for (const [key, value] of Object.entries(overrides)) {
    if (typeof value === 'string' && value.trim() !== '') {
      (out as unknown as Record<string, string>)[key] = value;
    }
  }
  return out;
}

/** Render a copy template with named placeholders. Replaces every
 *  occurrence of {key} in the input with the matching value. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] ?? '' : `{${key}}`,
  );
}
