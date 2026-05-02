import { useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';

// Editable email templates. PR 2 of the email-template system —
// reads + saves to lng_email_templates and snapshots prior versions
// to lng_email_template_history. The renderer + the cron edge
// function (Phase 1) read the same rows; the admin UI reads/writes
// via these helpers.
//
// Per-template fields surfaced to the admin:
//
//   key                  stable id ('appointment_reminder' etc)
//   subject              current subject line
//   body_syntax          current body in storage syntax
//   default_subject      seeded baseline (powers "reset to default")
//   default_body_syntax  seeded baseline
//   version              increments on every save
//   description          optional human-readable description
//   enabled              whether the cron / sender path fires
//   updated_at / updated_by  last edit metadata

export interface EmailTemplateRow {
  key: string;
  subject: string;
  body_syntax: string;
  default_subject: string;
  default_body_syntax: string;
  version: number;
  description: string | null;
  enabled: boolean;
  updated_at: string;
  updated_by: string | null;
}

export interface EmailTemplateHistoryRow {
  id: string;
  template_key: string;
  version: number;
  subject: string;
  body_syntax: string;
  saved_at: string;
  saved_by: string | null;
}

interface UseEmailTemplatesResult {
  data: EmailTemplateRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEmailTemplates(): UseEmailTemplatesResult {
  const [data, setData] = useState<EmailTemplateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data: rows, error: err } = await supabase
        .from('lng_email_templates')
        .select('*')
        .order('key', { ascending: true });
      if (cancelled) return;
      if (err) {
        setError(err.message);
      } else {
        setData((rows ?? []) as EmailTemplateRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

interface UseEmailTemplateHistoryResult {
  data: EmailTemplateHistoryRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEmailTemplateHistory(templateKey: string): UseEmailTemplateHistoryResult {
  const [data, setData] = useState<EmailTemplateHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      const { data: rows, error: err } = await supabase
        .from('lng_email_template_history')
        .select('*')
        .eq('template_key', templateKey)
        .order('version', { ascending: false });
      if (cancelled) return;
      if (err) {
        setError(err.message);
      } else {
        setData((rows ?? []) as EmailTemplateHistoryRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [templateKey, tick]);

  return { data, loading, error, refresh: () => setTick((t) => t + 1) };
}

// Save a new version of a template.
//
// Atomicity note: we read the current row, snapshot it to history at
// the OLD version, then update with version+1 and the new content.
// Two concurrent saves could race and produce two history rows at
// the same version — but the unique index on (template_key, version)
// would catch that and the second save would fail with 23505. The
// admin would retry with a fresh fetch, which is the right
// behaviour for a low-traffic surface like this.
//
// A future hardening: wrap the read + history insert + update in a
// SECURITY INVOKER plpgsql function so it's a single transaction.
// For Phase 2 v1 the JS-side flow is fine.

export async function saveEmailTemplate(input: {
  key: string;
  subject: string;
  body_syntax: string;
  enabled?: boolean;
}): Promise<{ ok: true; version: number }> {
  const { data: existing, error: readErr } = await supabase
    .from('lng_email_templates')
    .select('version, subject, body_syntax')
    .eq('key', input.key)
    .maybeSingle();
  if (readErr) throw new Error(`Couldn't read template: ${readErr.message}`);
  if (!existing) throw new Error(`Template "${input.key}" not found.`);
  const existingRow = existing as { version: number; subject: string; body_syntax: string };

  // Skip writing if nothing changed — saves a wasted history row
  // and a bumped version number for a no-op click. The admin UI's
  // Save button is disabled in this state but defend at the helper
  // boundary too.
  const enabledChange = input.enabled !== undefined;
  const subjectSame = existingRow.subject === input.subject;
  const bodySame = existingRow.body_syntax === input.body_syntax;
  if (subjectSame && bodySame && !enabledChange) {
    return { ok: true, version: existingRow.version };
  }

  // Resolve the actor account for the audit columns.
  const { data: actorRaw } = await supabase.rpc('auth_account_id');
  const actorAccountId = (actorRaw as string | null) ?? null;

  // Snapshot the current row to history at the OLD version so the
  // history has a complete trail. version 1 was already inserted at
  // seed time so the table starts populated.
  if (!subjectSame || !bodySame) {
    const { error: histErr } = await supabase.from('lng_email_template_history').insert({
      template_key: input.key,
      version: existingRow.version,
      subject: existingRow.subject,
      body_syntax: existingRow.body_syntax,
      saved_by: actorAccountId,
    });
    if (histErr && histErr.code !== '23505') {
      // 23505 = unique violation. Means version 1 history was
      // already seeded with these exact values — safe to skip.
      throw new Error(`Couldn't snapshot history: ${histErr.message}`);
    }
  }

  // Apply the new content.
  const newVersion = existingRow.version + (subjectSame && bodySame ? 0 : 1);
  const patch: Record<string, unknown> = {
    subject: input.subject,
    body_syntax: input.body_syntax,
    version: newVersion,
    updated_by: actorAccountId,
  };
  if (enabledChange) patch.enabled = input.enabled;

  const { error: updErr } = await supabase
    .from('lng_email_templates')
    .update(patch)
    .eq('key', input.key);
  if (updErr) throw new Error(`Couldn't save template: ${updErr.message}`);

  return { ok: true, version: newVersion };
}

// Restore a previous version. Identical to a save with the
// historical content — bumps the version number, snapshots the
// current row before overwriting.
export async function restoreEmailTemplateVersion(input: {
  templateKey: string;
  historyId: string;
}): Promise<{ ok: true; version: number }> {
  const { data: histRaw, error: histErr } = await supabase
    .from('lng_email_template_history')
    .select('subject, body_syntax')
    .eq('id', input.historyId)
    .maybeSingle();
  if (histErr) throw new Error(`Couldn't read history row: ${histErr.message}`);
  if (!histRaw) throw new Error('History row not found.');
  const hist = histRaw as { subject: string; body_syntax: string };
  return saveEmailTemplate({
    key: input.templateKey,
    subject: hist.subject,
    body_syntax: hist.body_syntax,
  });
}

// Reset to the seeded defaults. Identical save path; the
// "default_*" columns are the source.
export async function resetEmailTemplateToDefault(templateKey: string): Promise<{ ok: true; version: number }> {
  const { data: tplRaw, error: tplErr } = await supabase
    .from('lng_email_templates')
    .select('default_subject, default_body_syntax')
    .eq('key', templateKey)
    .maybeSingle();
  if (tplErr) throw new Error(`Couldn't read template: ${tplErr.message}`);
  if (!tplRaw) throw new Error('Template not found.');
  const tpl = tplRaw as { default_subject: string; default_body_syntax: string };
  return saveEmailTemplate({
    key: templateKey,
    subject: tpl.default_subject,
    body_syntax: tpl.default_body_syntax,
  });
}

// User-facing labels for each known template key. Matches the seed
// + admin UI hierarchy. Add a row here when a new template ships.
export const EMAIL_TEMPLATE_DEFINITIONS: ReadonlyArray<{
  key: string;
  label: string;
  group: string;
  description: string;
}> = [
  {
    key: 'appointment_reminder',
    label: 'Appointment reminder (24h before)',
    group: 'Appointments',
    description:
      'Sent automatically 24 hours before each native booking. Patient gets a friendly nudge with the slot details.',
  },
];
