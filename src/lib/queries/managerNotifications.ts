import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../supabase.ts';
import { listManagers, type ManagerRow } from './staff.ts';

// Manager notifications — recipient list + invocation helper.
//
// Per the May 2026 redesign, individual discount / refund / void
// actions no longer require picking a manager on the sheet. Instead,
// Admin → Emails → General → Manager notifications stores a list of
// accounts.id values in lng_settings under the key
// 'manager_notifications.recipient_account_ids'. Every listed manager
// receives an email when a cashier processes one of those actions.
//
// This module owns three things:
//
//   1. useManagerRecipients() — reads the configured list AND the
//      pool of active managers in one go, so the Admin card can
//      render every active manager with a checkbox reflecting its
//      current selected state.
//
//   2. setManagerRecipients() — persists the new list back to
//      lng_settings.
//
//   3. sendManagerNotification() — invokes the
//      send-manager-notification edge function. Best-effort: the
//      action that triggered it has already succeeded, so a network
//      blip must never bubble up as a user-facing error. Callers fire
//      and forget (the helper logs to console on failure).

const SETTINGS_KEY = 'manager_notifications.recipient_account_ids';

export interface ManagerRecipientOption {
  /** account_id — the value persisted in lng_settings */
  accountId: string;
  /** Display name, e.g. "Sarah Henderson" */
  name: string;
  /** Login email, e.g. "sarah@venneir.com" */
  email: string;
  /** Whether this account is currently in the saved recipients list */
  selected: boolean;
}

interface UseRecipientsResult {
  /** All active managers, with selected mirroring the saved list */
  options: ManagerRecipientOption[];
  /** Just the accounts.id values currently selected */
  selectedAccountIds: string[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useManagerRecipients(): UseRecipientsResult {
  const [managers, setManagers] = useState<ManagerRow[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const [managersRes, settingsRes] = await Promise.all([
          listManagers(),
          supabase
            .from('lng_settings')
            .select('value')
            .eq('key', SETTINGS_KEY)
            .is('location_id', null)
            .maybeSingle(),
        ]);
        if (cancelled) return;
        const settingErr = settingsRes.error;
        if (settingErr && settingErr.code !== 'PGRST116') {
          throw new Error(settingErr.message);
        }
        const raw = (settingsRes.data as { value: unknown } | null)?.value;
        const selectedIds = Array.isArray(raw)
          ? raw.filter((v): v is string => typeof v === 'string')
          : [];
        setManagers(managersRes);
        setSelected(selectedIds);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load recipients');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const options: ManagerRecipientOption[] = managers
    .map((m) => ({
      accountId: m.account_id,
      name: m.name,
      email: m.login_email,
      selected: selected.includes(m.account_id),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return {
    options,
    selectedAccountIds: selected,
    loading,
    error,
    refresh: useCallback(() => setTick((t) => t + 1), []),
  };
}

// Persists the recipient list. Upserts the lng_settings row by
// (key WHERE location_id IS NULL) so an admin can configure the
// list before any code has written the row yet (covers fresh shadow
// DBs that haven't run the seed migration).
export async function setManagerRecipients(accountIds: string[]): Promise<void> {
  const cleaned = Array.from(new Set(accountIds.filter((id) => typeof id === 'string' && id.length > 0)));
  const { data: existing, error: readErr } = await supabase
    .from('lng_settings')
    .select('id')
    .eq('key', SETTINGS_KEY)
    .is('location_id', null)
    .maybeSingle();
  if (readErr && readErr.code !== 'PGRST116') {
    throw new Error(readErr.message);
  }
  if (existing) {
    const { error: updErr } = await supabase
      .from('lng_settings')
      .update({ value: cleaned })
      .eq('id', (existing as { id: string }).id);
    if (updErr) throw new Error(updErr.message);
    return;
  }
  const { error: insErr } = await supabase.from('lng_settings').insert({
    location_id: null,
    key: SETTINGS_KEY,
    value: cleaned,
    description:
      'JSONB array of accounts.id values. Each listed manager receives the manager_notification email whenever a cashier applies, amends, or removes a discount, issues a refund, or voids a payment. Managed from Admin → Emails → General → Manager notifications.',
  });
  if (insErr) throw new Error(insErr.message);
}

// Lightweight read used by the sheets. Returns the currently-selected
// recipients resolved to { name, email } so the notice can list them
// inline ("Sarah, James and 2 others will be notified"). Drops anyone
// who is no longer an active manager — same logic the edge function
// applies at send time, so the on-sheet preview matches what actually
// goes out.
export interface ResolvedRecipient {
  accountId: string;
  name: string;
  email: string;
}

export async function listResolvedManagerRecipients(): Promise<ResolvedRecipient[]> {
  const { data: settings, error: settingsErr } = await supabase
    .from('lng_settings')
    .select('value')
    .eq('key', SETTINGS_KEY)
    .is('location_id', null)
    .maybeSingle();
  if (settingsErr && settingsErr.code !== 'PGRST116') throw new Error(settingsErr.message);
  const raw = (settings as { value: unknown } | null)?.value;
  const ids = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  if (ids.length === 0) return [];
  const managers = await listManagers();
  const byId = new Map(managers.map((m) => [m.account_id, m] as const));
  return ids
    .map((id) => {
      const m = byId.get(id);
      if (!m) return null;
      return { accountId: m.account_id, name: m.name, email: m.login_email };
    })
    .filter((r): r is ResolvedRecipient => r !== null);
}

export function useResolvedManagerRecipients(): {
  recipients: ResolvedRecipient[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
} {
  const [recipients, setRecipients] = useState<ResolvedRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await listResolvedManagerRecipients();
        if (cancelled) return;
        setRecipients(list);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'Could not load recipients');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  return {
    recipients,
    loading,
    error,
    refresh: useCallback(() => setTick((t) => t + 1), []),
  };
}

// Fire-and-forget invocation of the edge function. The action that
// triggered this call has already succeeded; if the email send fails
// for any reason, the failure is logged server-side to
// lng_system_failures and we resolve `ok:false` so a caller that
// wants to surface a soft warning can. We never throw — patient-axis
// actions must not break because a notification email blipped.
export type ManagerNotificationActionKind =
  | 'discount_applied'
  | 'discount_amended'
  | 'discount_removed'
  | 'refund_issued'
  | 'payment_voided';

export interface SendManagerNotificationInput {
  actionKind: ManagerNotificationActionKind;
  amountPence: number;
  reason: string;
  patientId: string | null;
  visitId: string | null;
  staffAccountId: string | null;
}

export interface SendManagerNotificationResult {
  ok: boolean;
  recipients?: number;
  delivered?: number;
  failed?: number;
  error?: string;
}

export async function sendManagerNotification(
  input: SendManagerNotificationInput,
): Promise<SendManagerNotificationResult> {
  try {
    const { data, error } = await supabase.functions.invoke<unknown>(
      'send-manager-notification',
      {
        body: {
          action_kind: input.actionKind,
          amount_pence: input.amountPence,
          reason: input.reason,
          patient_id: input.patientId,
          visit_id: input.visitId,
          staff_account_id: input.staffAccountId,
        },
      },
    );
    if (error) {
      console.warn('send-manager-notification invoke failed:', error.message);
      return { ok: false, error: error.message };
    }
    const payload = (data ?? {}) as SendManagerNotificationResult;
    return payload;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('send-manager-notification unexpected error:', msg);
    return { ok: false, error: msg };
  }
}
