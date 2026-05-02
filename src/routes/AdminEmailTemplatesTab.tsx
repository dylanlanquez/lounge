import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Mail, Power } from 'lucide-react';
import { Button, Card, Input, Skeleton, SnippetEditor, Toast } from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  type EmailTemplateRow,
  EMAIL_TEMPLATE_DEFINITIONS,
  saveEmailTemplate,
  useEmailTemplates,
} from '../lib/queries/emailTemplates.ts';

// Admin → Email templates tab.
//
// Renders the list of editable email templates grouped by section.
// For PR 2b the surface is intentionally focused: subject + body +
// save / cancel + enabled toggle. The variables sidebar, live
// preview, version history and "send test" actions ship in
// PR 2c / PR 2d.
//
// Pattern: list rows expand inline (accordion) into a full-width
// editor pane. Clicking a different row collapses the previous so
// only one is open at a time — keeps the screen state simple and
// matches Checkpoint's surface.

export function AdminEmailTemplatesTab() {
  const templates = useEmailTemplates();
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    tone: 'success' | 'error' | 'info';
    title: string;
    description?: string;
  } | null>(null);

  // Group templates by their definition's group field.
  const groups = useMemo(() => {
    const seen = new Map<string, string[]>();
    for (const def of EMAIL_TEMPLATE_DEFINITIONS) {
      const list = seen.get(def.group) ?? [];
      list.push(def.key);
      seen.set(def.group, list);
    }
    return Array.from(seen.entries());
  }, []);

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
          Email templates
        </p>
        <p
          style={{
            margin: `${theme.space[1]}px 0 0`,
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          Subject and body for the transactional emails Lounge sends to patients. Edits go live
          on the next send. Use {'{{variable}}'} placeholders to drop in patient and appointment
          details — the variables sidebar (coming next) will list every available one.
        </p>
      </header>

      {templates.loading ? (
        <Card padding="md">
          <Skeleton height={64} />
        </Card>
      ) : templates.error ? (
        <Card padding="md">
          <p style={{ margin: 0, color: theme.color.alert, fontSize: theme.type.size.sm }}>
            Couldn't load templates: {templates.error}
          </p>
        </Card>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[5] }}>
          {groups.map(([groupName, keys]) => (
            <section
              key={groupName}
              style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}
            >
              <p
                style={{
                  margin: 0,
                  fontSize: 11,
                  fontWeight: theme.type.weight.semibold,
                  color: theme.color.inkMuted,
                  textTransform: 'uppercase',
                  letterSpacing: theme.type.tracking.wide,
                }}
              >
                {groupName}
              </p>
              <Card padding="none">
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {keys.map((key, idx) => {
                    const tpl = templates.data.find((t) => t.key === key);
                    const def = EMAIL_TEMPLATE_DEFINITIONS.find((d) => d.key === key);
                    if (!tpl || !def) return null;
                    return (
                      <TemplateRow
                        key={key}
                        template={tpl}
                        definition={def}
                        isFirst={idx === 0}
                        isOpen={openKey === key}
                        onToggle={() =>
                          setOpenKey((prev) => (prev === key ? null : key))
                        }
                        onSaved={() => {
                          templates.refresh();
                          setToast({
                            tone: 'success',
                            title: 'Template saved',
                            description: def.label,
                          });
                        }}
                        onError={(msg) =>
                          setToast({
                            tone: 'error',
                            title: 'Could not save',
                            description: msg,
                          })
                        }
                      />
                    );
                  })}
                </ul>
              </Card>
            </section>
          ))}
        </div>
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

// ─────────────────────────────────────────────────────────────────────────────
// Single row: collapsed summary OR expanded editor pane
// ─────────────────────────────────────────────────────────────────────────────

function TemplateRow({
  template,
  definition,
  isFirst,
  isOpen,
  onToggle,
  onSaved,
  onError,
}: {
  template: EmailTemplateRow;
  definition: { key: string; label: string; description: string };
  isFirst: boolean;
  isOpen: boolean;
  onToggle: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  // Local draft state — independent of the saved row until "Save"
  // commits. Re-seeded whenever the underlying row changes (e.g.
  // version bump elsewhere) or the row is collapsed and re-opened.
  const [subject, setSubject] = useState(template.subject);
  const [body, setBody] = useState(template.body_syntax);
  const [enabled, setEnabled] = useState(template.enabled);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setSubject(template.subject);
    setBody(template.body_syntax);
    setEnabled(template.enabled);
  }, [isOpen, template.subject, template.body_syntax, template.enabled, template.version]);

  const dirty =
    subject !== template.subject ||
    body !== template.body_syntax ||
    enabled !== template.enabled;

  const handleSave = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await saveEmailTemplate({
        key: template.key,
        subject,
        body_syntax: body,
        enabled,
      });
      onSaved();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setSubject(template.subject);
    setBody(template.body_syntax);
    setEnabled(template.enabled);
    onToggle(); // collapses
  };

  return (
    <li
      style={{
        borderTop: isFirst ? 'none' : `1px solid ${theme.color.border}`,
      }}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isOpen}
        style={{
          appearance: 'none',
          width: '100%',
          background: 'transparent',
          border: 'none',
          padding: `${theme.space[4]}px ${theme.space[5]}px`,
          display: 'flex',
          alignItems: 'center',
          gap: theme.space[3],
          fontFamily: 'inherit',
          cursor: 'pointer',
          textAlign: 'left',
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
        onMouseEnter={(e) => {
          if (isOpen) return;
          e.currentTarget.style.background = theme.color.bg;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'transparent';
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
            background: template.enabled ? theme.color.accentBg : theme.color.bg,
            color: template.enabled ? theme.color.accent : theme.color.inkMuted,
            border: `1px solid ${theme.color.border}`,
            flexShrink: 0,
          }}
        >
          <Mail size={14} aria-hidden />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p
            style={{
              margin: 0,
              fontSize: theme.type.size.md,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              letterSpacing: theme.type.tracking.tight,
            }}
          >
            {definition.label}
          </p>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: theme.type.size.xs,
              color: theme.color.inkMuted,
              lineHeight: theme.type.leading.snug,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {definition.description}
          </p>
        </div>
        {!template.enabled ? (
          <span
            aria-label="Paused"
            style={{
              fontSize: 11,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.inkMuted,
              padding: `2px ${theme.space[2]}px`,
              border: `1px solid ${theme.color.border}`,
              borderRadius: theme.radius.pill,
              textTransform: 'uppercase',
              letterSpacing: theme.type.tracking.wide,
              flexShrink: 0,
            }}
          >
            Paused
          </span>
        ) : null}
        <span style={{ color: theme.color.inkSubtle, flexShrink: 0, display: 'inline-flex' }}>
          {isOpen ? <ChevronDown size={16} aria-hidden /> : <ChevronRight size={16} aria-hidden />}
        </span>
      </button>

      {isOpen ? (
        <div
          style={{
            padding: `${theme.space[3]}px ${theme.space[5]}px ${theme.space[5]}px`,
            background: theme.color.bg,
            borderTop: `1px solid ${theme.color.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.space[4],
          }}
        >
          <Input
            label="Subject"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            placeholder="Subject line that lands in the patient's inbox"
            helper="Plain text, with {{variable}} placeholders allowed."
          />

          <div>
            <p
              style={{
                margin: 0,
                marginBottom: theme.space[1],
                fontSize: theme.type.size.sm,
                fontWeight: theme.type.weight.medium,
                color: theme.color.ink,
              }}
            >
              Body
            </p>
            <SnippetEditor value={body} onChange={setBody} />
            <p
              style={{
                margin: `${theme.space[2]}px 0 0`,
                fontSize: theme.type.size.xs,
                color: theme.color.inkMuted,
                lineHeight: theme.type.leading.snug,
              }}
            >
              Use the toolbar for formatting, the button icon for tappable CTAs, and{' '}
              {'{{variable}}'} placeholders for dynamic content. Pasting from another app strips
              its formatting so nothing unexpected sneaks in.
            </p>
          </div>

          <EnabledToggle
            enabled={enabled}
            onChange={setEnabled}
            description={
              enabled
                ? 'This template is live. Sends fire whenever the trigger conditions are met.'
                : 'This template is paused. Sends are skipped until you re-enable it.'
            }
          />

          <FooterActions
            saving={saving}
            dirty={dirty}
            version={template.version}
            updatedAt={template.updated_at}
            onCancel={handleCancel}
            onSave={handleSave}
          />
        </div>
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────────────────────

function EnabledToggle({
  enabled,
  onChange,
  description,
}: {
  enabled: boolean;
  onChange: (next: boolean) => void;
  description: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: theme.space[3],
        padding: `${theme.space[3]}px ${theme.space[4]}px`,
        background: theme.color.surface,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
      }}
    >
      <span
        aria-hidden
        style={{
          color: enabled ? theme.color.accent : theme.color.inkMuted,
          marginTop: 2,
          flexShrink: 0,
          display: 'inline-flex',
        }}
      >
        <Power size={16} aria-hidden />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          onClick={() => onChange(!enabled)}
          style={{
            appearance: 'none',
            border: 'none',
            background: 'transparent',
            padding: 0,
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: theme.space[2],
            fontFamily: 'inherit',
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              width: 36,
              height: 20,
              borderRadius: 999,
              background: enabled ? theme.color.accent : theme.color.border,
              padding: 2,
              transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
            }}
          >
            <span
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                background: theme.color.surface,
                transform: enabled ? 'translateX(16px)' : 'translateX(0)',
                transition: `transform ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
              }}
            />
          </span>
          <span
            style={{
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
            }}
          >
            {enabled ? 'Enabled' : 'Paused'}
          </span>
        </button>
        <p
          style={{
            margin: '4px 0 0',
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            lineHeight: theme.type.leading.snug,
          }}
        >
          {description}
        </p>
      </div>
    </div>
  );
}

function FooterActions({
  saving,
  dirty,
  version,
  updatedAt,
  onCancel,
  onSave,
}: {
  saving: boolean;
  dirty: boolean;
  version: number;
  updatedAt: string;
  onCancel: () => void;
  onSave: () => void;
}) {
  const updatedDate = new Date(updatedAt);
  const updatedLabel = Number.isNaN(updatedDate.getTime())
    ? '—'
    : updatedDate.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        flexWrap: 'wrap',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          Version {version} · last edited {updatedLabel}
        </span>
      </div>
      <div style={{ display: 'flex', gap: theme.space[2] }}>
        <Button variant="tertiary" onClick={onCancel} disabled={saving}>
          {dirty ? 'Cancel' : 'Close'}
        </Button>
        <Button variant="primary" onClick={onSave} disabled={!dirty || saving} loading={saving}>
          {saving ? 'Saving…' : 'Save changes'}
        </Button>
      </div>
    </div>
  );
}
