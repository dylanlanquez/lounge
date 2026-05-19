import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Mail } from 'lucide-react';
import { Button, Card, Input, Skeleton, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  type SmsTemplateRow,
  SMS_TEMPLATE_VARIABLES,
  humaniseSmsKey,
  removeSmsTemplateOverride,
  resetSmsTemplateToDefault,
  renderSmsPreview,
  saveSmsTemplate,
  smsDisplayName,
  summariseSmsBody,
  useSmsTemplates,
} from '../lib/queries/smsTemplates.ts';
import { ServicePills } from './AdminEmailTemplatesTab.tsx';

// Admin > SMS tab.
//
// Booking-type pills sit at the top, mirroring the email side —
// except virtual + in-person impression appointments don't merit
// SMS (those flows are remote / scheduled), so the SMS pill list
// is the shorter set: General, Click-in veneers, Same-day appliance,
// Denture repair.
//
// Each template_key shows once per pill: the General row in the
// General pill, the override row (if one exists) in the service-
// typed pill, otherwise a SmsInheritedRow placeholder offering a
// "Customise" affordance that creates the override seeded from
// General.

// Pills for SMS. Shorter than the email pill list — the two
// impression services don't merit SMS so they're omitted to keep
// the surface focused on services that actually fire texts.
const SMS_SERVICE_PILLS: ReadonlyArray<{ label: string; value: string | null }> = [
  { label: 'General', value: null },
  { label: 'Click-in veneers', value: 'click_in_veneers' },
  { label: 'Same-day appliance', value: 'same_day_appliance' },
  { label: 'Denture repair', value: 'denture_repair' },
];

// Canonical row order. Visit-ready is the primary template; the
// four below it are the manually-sent secondary keys.
const SMS_TEMPLATE_KEYS: ReadonlyArray<string> = [
  'visit_ready',
  'please_return',
  'please_call',
  'running_late',
  'reminder_to_attend',
];

type ToastMsg = { tone: 'success' | 'error' | 'info'; title: string; description?: string };

export function AdminSmsTemplatesTab() {
  const templates = useSmsTemplates();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [selectedServiceType, setSelectedServiceType] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastMsg | null>(null);

  // Close any open row when the pill switches — the open key may
  // not have an override on the new tab, and re-opening picks up
  // the right context cleanly. Same pattern as the email side.
  useEffect(() => {
    setOpenKey(null);
  }, [selectedServiceType]);

  // Index by (key, service_type) for O(1) per-pill lookup.
  const rowByKeyAndService = useMemo(() => {
    const map = new Map<string, SmsTemplateRow>();
    for (const r of templates.data) {
      map.set(`${r.key}|${r.service_type ?? '__general__'}`, r);
    }
    return map;
  }, [templates.data]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
      <header>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.md,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
            letterSpacing: theme.type.tracking.tight,
          }}
        >
          SMS templates
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Plain-text messages Lounge fires via Twilio. Use {'{{variable}}'} placeholders the same way as
          emails. Keep the body tight, every 160 characters becomes another paid SMS segment. Pick a
          booking type to customise its copy; if no override is set the booking falls back to General.
        </p>
      </header>

      <ServicePills
        pills={SMS_SERVICE_PILLS}
        selected={selectedServiceType}
        onSelect={setSelectedServiceType}
      />

      {templates.loading ? (
        <Card padding="md">
          <Skeleton height={48} />
        </Card>
      ) : templates.error ? (
        <Card padding="md">
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            Couldn't load SMS templates: {templates.error}
          </p>
        </Card>
      ) : (
        <Card padding="none">
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {SMS_TEMPLATE_KEYS.map((key, idx) => {
              const variantKey = `${key}|${selectedServiceType ?? '__general__'}`;
              const tpl = rowByKeyAndService.get(variantKey) ?? null;
              const generalRow = rowByKeyAndService.get(`${key}|__general__`) ?? null;

              // Inherited placeholder for a service-typed pill where
              // no override exists yet.
              if (selectedServiceType !== null && !tpl) {
                if (!generalRow) return null;
                return (
                  <SmsInheritedRow
                    key={key}
                    templateKey={key}
                    serviceType={selectedServiceType}
                    serviceLabel={
                      SMS_SERVICE_PILLS.find((p) => p.value === selectedServiceType)
                        ?.label ?? 'this service'
                    }
                    generalRow={generalRow}
                    isFirst={idx === 0}
                    onCustomised={() => templates.refresh()}
                    onToast={setToast}
                  />
                );
              }

              if (!tpl) return null;
              return (
                <SmsTemplateRowComponent
                  key={key}
                  row={tpl}
                  serviceType={selectedServiceType}
                  serviceLabel={
                    SMS_SERVICE_PILLS.find((p) => p.value === selectedServiceType)
                      ?.label ?? null
                  }
                  isFirst={idx === 0}
                  isOpen={openKey === key}
                  onToggle={() => setOpenKey((prev) => (prev === key ? null : key))}
                  onRefresh={() => templates.refresh()}
                  onToast={setToast}
                />
              );
            })}
          </ul>
        </Card>
      )}

      {toast ? (
        <div
          style={{
            position: 'fixed',
            bottom: theme.space[6],
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 100,
          }}
        >
          <Toast
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            onDismiss={() => setToast(null)}
          />
        </div>
      ) : null}
    </div>
  );
}

function SmsInheritedRow({
  templateKey,
  serviceType,
  serviceLabel,
  generalRow,
  isFirst,
  onCustomised,
  onToast,
}: {
  templateKey: string;
  serviceType: string;
  serviceLabel: string;
  generalRow: SmsTemplateRow;
  isFirst: boolean;
  onCustomised: () => void;
  onToast: (t: ToastMsg) => void;
}) {
  const [creating, setCreating] = useState(false);
  const handleCustomise = async () => {
    if (creating) return;
    setCreating(true);
    try {
      await saveSmsTemplate({
        key: templateKey,
        service_type: serviceType,
        body: generalRow.body,
        enabled: true,
      });
      onToast({
        tone: 'success',
        title: `Customised for ${serviceLabel}`,
        description: humaniseSmsKey(templateKey),
      });
      onCustomised();
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not create override',
        description: e instanceof Error ? e.message : 'Unknown error',
      });
    } finally {
      setCreating(false);
    }
  };
  return (
    <li
      style={{
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
        padding: `${theme.space[4]}px ${theme.space[5]}px`,
        display: 'flex',
        alignItems: 'center',
        gap: theme.space[3],
      }}
    >
      <Mail size={16} aria-hidden style={{ color: theme.color.inkMuted, flexShrink: 0 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontSize: theme.type.size.sm,
            fontWeight: theme.type.weight.semibold,
            color: theme.color.ink,
          }}
        >
          {smsDisplayName(generalRow)}
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Inherits the General copy. Customise to write {serviceLabel}-specific wording.
        </p>
      </div>
      <Button
        variant="tertiary"
        size="sm"
        onClick={handleCustomise}
        loading={creating}
      >
        Customise
      </Button>
    </li>
  );
}

function SmsTemplateRowComponent({
  row,
  serviceType,
  serviceLabel,
  isFirst,
  isOpen,
  onToggle,
  onRefresh,
  onToast,
}: {
  row: SmsTemplateRow;
  /** null when on the General pill, non-null when on a service-typed pill. */
  serviceType: string | null;
  /** Human label for the active pill, e.g. "Click-in veneers". */
  serviceLabel: string | null;
  isFirst: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onRefresh: () => void;
  onToast: (t: ToastMsg) => void;
}) {
  const [body, setBody] = useState(row.body);
  const [displayName, setDisplayName] = useState(row.display_name ?? '');
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-seed the editors on open / external version bump so they
  // don't strand stale edits if the row is refetched.
  useEffect(() => {
    if (!isOpen) return;
    setBody(row.body);
    setDisplayName(row.display_name ?? '');
  }, [isOpen, row.body, row.version, row.display_name]);

  const dirty =
    body !== row.body ||
    (displayName.trim() || null) !== (row.display_name ?? null);
  const preview = useMemo(() => renderSmsPreview(body), [body]);
  const summary = useMemo(() => summariseSmsBody(preview), [preview]);

  const handleInsertVariable = (name: string) => {
    const el = textareaRef.current;
    if (!el) {
      setBody((b) => `${b}{{${name}}}`);
      return;
    }
    const start = el.selectionStart ?? body.length;
    const end = el.selectionEnd ?? body.length;
    const next = body.slice(0, start) + `{{${name}}}` + body.slice(end);
    setBody(next);
    requestAnimationFrame(() => {
      el.focus();
      const caret = start + `{{${name}}}`.length;
      el.setSelectionRange(caret, caret);
    });
  };

  const handleSave = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await saveSmsTemplate({
        key: row.key,
        service_type: serviceType,
        body,
        display_name: displayName,
      });
      onRefresh();
      onToast({ tone: 'success', title: 'SMS template saved' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    if (resetting) return;
    setResetting(true);
    try {
      await resetSmsTemplateToDefault({ key: row.key, service_type: serviceType });
      onRefresh();
      onToast({ tone: 'success', title: 'Reset to default' });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Reset failed',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setResetting(false);
    }
  };

  // Remove a service-typed override so the booking falls back to
  // General. Only available on service-typed pills.
  const handleRemoveOverride = async () => {
    if (removing || !serviceType) return;
    setRemoving(true);
    try {
      await removeSmsTemplateOverride({ key: row.key, service_type: serviceType });
      onRefresh();
      onToast({
        tone: 'success',
        title: 'Override removed',
        description: `Now using the General copy for ${serviceLabel ?? 'this service'}.`,
      });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not remove override',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setRemoving(false);
    }
  };

  // Toggle the row's `enabled` flag. Receptionists' Send-an-SMS picker
  // hides disabled templates, and the edge function refuses to send
  // them, so this is the single switch that controls "is this text
  // available to be sent?" — exactly the question admins ask when
  // glancing at the row.
  const [togglingEnabled, setTogglingEnabled] = useState(false);
  const handleToggleEnabled = async (next: boolean) => {
    if (togglingEnabled) return;
    setTogglingEnabled(true);
    try {
      await saveSmsTemplate({
        key: row.key,
        service_type: serviceType,
        // saveSmsTemplate routes to update when (key, service_type)
        // exists, so passing the same body preserves it; only the
        // enabled flag flips. For the General row this is always the
        // existing-row path; for a service-typed pill where no
        // override exists yet, this would create one — but the row
        // wouldn't render here in that case (the SmsInheritedRow
        // placeholder would). So we're always editing an existing row.
        body: row.body,
        enabled: next,
      });
      onRefresh();
      onToast({
        tone: 'success',
        title: next ? 'Showing in Send-an-SMS picker' : 'Hidden from Send-an-SMS picker',
      });
    } catch (e) {
      onToast({
        tone: 'error',
        title: 'Could not change visibility',
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setTogglingEnabled(false);
    }
  };

  return (
    <li style={{ borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}` }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
        }}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isOpen}
          aria-label={isOpen ? `Collapse ${smsDisplayName(row)}` : `Expand ${smsDisplayName(row)}`}
          style={{
            appearance: 'none',
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
            padding: 0,
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[3],
          }}
        >
          <span
            aria-hidden
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              borderRadius: theme.radius.pill,
              background: row.enabled ? theme.color.accentBg : theme.color.bg,
              color: row.enabled ? theme.color.accent : theme.color.inkMuted,
              border: row.enabled ? 'none' : `1px solid ${theme.color.border}`,
              flexShrink: 0,
            }}
          >
            <Mail size={16} />
          </span>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <span
              style={{
                fontSize: theme.type.size.base,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              {smsDisplayName(row)}
            </span>
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted }}>
              {row.description ?? 'SMS template.'}
            </span>
          </div>
        </button>
        {/* Show-in-picker toggle. Sits outside the expand button so a
            tap on the switch doesn't also expand the row. */}
        <ShowInPickerToggle
          checked={row.enabled}
          disabled={togglingEnabled}
          onChange={handleToggleEnabled}
        />
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkSubtle,
            fontVariantNumeric: 'tabular-nums',
            flexShrink: 0,
          }}
        >
          v{row.version}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-label={isOpen ? 'Collapse' : 'Expand'}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 'none',
            padding: 4,
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            color: theme.color.inkMuted,
          }}
        >
          {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
      </div>

      {isOpen ? (
        <div
          style={{
            padding: `0 ${theme.space[5]}px ${theme.space[5]}px`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[4],
          }}
        >
          {/* Name editor. Per row, so each pill can carry its own
              label. The receptionist's Send-an-SMS picker on the
              Visit page reads from the General row, so editing on
              a service-typed pill renames how this override reads in
              admin without affecting the picker. Blank falls back
              to the built-in humanised label. */}
          <Input
            label="Name in the picker"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder={humaniseSmsKey(row.key)}
            helper={
              serviceType
                ? `Renames this ${serviceLabel ?? 'override'} row in admin. The Send-an-SMS dropdown on the Visit page always reads from the General row, so to change what the receptionist sees, edit the name on the General pill.`
                : "Shown as the title of this row and as the option label in the Send-an-SMS dropdown on the Visit page. Leave blank to use the default."
            }
          />

          {/* Editor */}
          <label
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: theme.space[2],
            }}
          >
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              Body
            </span>
            <textarea
              ref={textareaRef}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              spellCheck
              style={{
                appearance: 'none',
                width: '100%',
                resize: 'vertical',
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
                color: theme.color.ink,
                fontSize: theme.type.size.base,
                lineHeight: theme.type.leading.normal,
                fontFamily: 'inherit',
              }}
            />
            <div
              style={{
                display: 'flex',
                gap: theme.space[3],
                justifyContent: 'space-between',
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              <span>
                {summary.characters} character{summary.characters === 1 ? '' : 's'} ·{' '}
                <span
                  style={{
                    fontWeight:
                      summary.segments > 1 ? theme.type.weight.semibold : theme.type.weight.medium,
                    color: summary.segments > 1 ? theme.color.warn : theme.color.inkMuted,
                  }}
                >
                  {summary.segments} segment{summary.segments === 1 ? '' : 's'}
                </span>
              </span>
              <span>{summary.encoding === 'gsm-7' ? 'GSM-7 (standard)' : 'UCS-2 (unicode, segments halve)'}</span>
            </div>
          </label>

          {/* Variable picker */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              Insert variable
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: theme.space[2] }}>
              {SMS_TEMPLATE_VARIABLES.map((v) => (
                <button
                  key={v.name}
                  type="button"
                  onClick={() => handleInsertVariable(v.name)}
                  title={v.description}
                  style={{
                    appearance: 'none',
                    fontFamily: 'inherit',
                    fontSize: theme.type.size.xs,
                    fontWeight: theme.type.weight.medium,
                    padding: `${theme.space[1]}px ${theme.space[3]}px`,
                    borderRadius: theme.radius.pill,
                    border: `1px solid ${theme.color.border}`,
                    background: theme.color.surface,
                    color: theme.color.ink,
                    cursor: 'pointer',
                  }}
                >
                  {v.label} ·{' '}
                  <code
                    style={{
                      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
                      fontSize: 11,
                      color: theme.color.inkMuted,
                    }}
                  >
                    {`{{${v.name}}}`}
                  </code>
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[2] }}>
            <span
              style={{
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.semibold,
                color: theme.color.ink,
                letterSpacing: theme.type.tracking.tight,
              }}
            >
              Preview
            </span>
            <p
              style={{
                margin: 0,
                padding: `${theme.space[3]}px ${theme.space[4]}px`,
                borderRadius: theme.radius.card,
                background: theme.color.bg,
                border: `1px solid ${theme.color.border}`,
                fontSize: theme.type.size.base,
                lineHeight: theme.type.leading.normal,
                color: theme.color.ink,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {preview || (
                <span style={{ color: theme.color.inkSubtle }}>
                  Type a message above to see how it'll read on the patient's lock screen.
                </span>
              )}
            </p>
          </div>

          {/* Actions */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: theme.space[2],
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', gap: theme.space[2], flexWrap: 'wrap' }}>
              <Button
                variant="tertiary"
                onClick={handleReset}
                disabled={resetting || saving || body === row.default_body}
              >
                {resetting ? 'Resetting…' : 'Reset to default'}
              </Button>
              {serviceType ? (
                <Button
                  variant="tertiary"
                  onClick={handleRemoveOverride}
                  disabled={removing || saving}
                >
                  {removing ? 'Removing…' : `Remove ${serviceLabel ?? 'override'} override`}
                </Button>
              ) : null}
            </div>
            <div style={{ display: 'flex', gap: theme.space[2] }}>
              <Button
                variant="tertiary"
                onClick={() => setBody(row.body)}
                disabled={!dirty || saving}
              >
                Cancel
              </Button>
              <Button variant="primary" onClick={handleSave} disabled={!dirty || saving}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  );
}

// Compact iOS-style switch for the per-template "show in picker"
// toggle. Lives next to the row title so admins can pause a template
// from the receptionist's Send-an-SMS dropdown without expanding the
// editor pane.
function ShowInPickerToggle({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[2],
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden
        style={{
          fontSize: theme.type.size.xs,
          color: checked ? theme.color.ink : theme.color.inkMuted,
          fontWeight: theme.type.weight.medium,
          whiteSpace: 'nowrap',
        }}
      >
        {checked ? 'In picker' : 'Hidden'}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={checked ? 'Hide from Send-an-SMS picker' : 'Show in Send-an-SMS picker'}
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          onChange(!checked);
        }}
        style={{
          appearance: 'none',
          border: 'none',
          padding: 0,
          width: 40,
          height: 24,
          borderRadius: 999,
          background: checked ? theme.color.accent : theme.color.border,
          cursor: disabled ? 'wait' : 'pointer',
          position: 'relative',
          transition: 'background 0.15s ease',
          flexShrink: 0,
          opacity: disabled ? 0.6 : 1,
        }}
      >
        <span
          aria-hidden
          style={{
            position: 'absolute',
            top: 2,
            left: checked ? 18 : 2,
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.18)',
            transition: 'left 0.18s ease',
          }}
        />
      </button>
    </span>
  );
}
