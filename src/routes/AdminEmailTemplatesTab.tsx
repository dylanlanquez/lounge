import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Eye,
  Mail,
  Pencil,
  Power,
  RotateCcw,
} from 'lucide-react';
import type { Editor } from '@tiptap/react';
import {
  Button,
  Card,
  Dialog,
  Input,
  Skeleton,
  SnippetEditor,
  Toast,
} from '../components/index.ts';
import { theme } from '../theme/index.ts';
import {
  type EmailTemplateDefinition,
  type EmailTemplateRow,
  type EmailTemplateVariable,
  EMAIL_TEMPLATE_DEFINITIONS,
  resetEmailTemplateToDefault,
  sampleVariablesFor,
  saveEmailTemplate,
  useEmailTemplates,
} from '../lib/queries/emailTemplates.ts';
import { renderEmail } from '../lib/emailRenderer.ts';

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
  definition: EmailTemplateDefinition;
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
  const [resetting, setResetting] = useState(false);
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [bodyMode, setBodyMode] = useState<'edit' | 'preview'>('edit');
  const editorRef = useRef<Editor | null>(null);

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
            <BodyHeader
              mode={bodyMode}
              onModeChange={setBodyMode}
              onInsertVariable={(name) => {
                const editor = editorRef.current;
                if (!editor) return;
                editor.chain().focus().insertContent(`{{${name}}}`).run();
              }}
              variables={definition.variables}
            />
            {bodyMode === 'edit' ? (
              <SnippetEditor value={body} onChange={setBody} editorRef={editorRef} />
            ) : (
              <BodyPreview templateKey={template.key} subject={subject} body={body} />
            )}
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
            onResetClick={() => setResetConfirmOpen(true)}
            resetting={resetting}
          />
        </div>
      ) : null}

      {resetConfirmOpen ? (
        <Dialog
          open
          onClose={resetting ? () => undefined : () => setResetConfirmOpen(false)}
          width={460}
          title="Reset to default copy?"
          description={
            <span>
              This replaces the current subject and body with the seeded baseline. Your edits
              will be saved as the next version in the history, so you can roll back if you
              change your mind.
            </span>
          }
          footer={
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
              <Button
                variant="tertiary"
                onClick={() => setResetConfirmOpen(false)}
                disabled={resetting}
              >
                Keep current
              </Button>
              <Button
                variant="primary"
                loading={resetting}
                onClick={async () => {
                  setResetting(true);
                  try {
                    await resetEmailTemplateToDefault(template.key);
                    setResetConfirmOpen(false);
                    onSaved();
                  } catch (e) {
                    onError(e instanceof Error ? e.message : 'Could not reset');
                  } finally {
                    setResetting(false);
                  }
                }}
              >
                {resetting ? 'Resetting…' : 'Reset to default'}
              </Button>
            </div>
          }
        >
          <span />
        </Dialog>
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
  onResetClick,
  resetting,
}: {
  saving: boolean;
  dirty: boolean;
  version: number;
  updatedAt: string;
  onCancel: () => void;
  onSave: () => void;
  onResetClick: () => void;
  resetting: boolean;
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
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          Version {version} · last edited {updatedLabel}
        </span>
        <button
          type="button"
          onClick={onResetClick}
          disabled={resetting || saving}
          style={{
            appearance: 'none',
            background: 'transparent',
            border: 'none',
            padding: 0,
            cursor: resetting || saving ? 'default' : 'pointer',
            fontFamily: 'inherit',
            fontSize: theme.type.size.xs,
            color: theme.color.inkMuted,
            display: 'inline-flex',
            alignItems: 'center',
            gap: theme.space[1],
            opacity: resetting || saving ? 0.5 : 1,
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          <RotateCcw size={12} aria-hidden /> Reset to default
        </button>
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

// ─────────────────────────────────────────────────────────────────────────────
// Body header — Edit / Preview toggle + Insert variable dropdown
// ─────────────────────────────────────────────────────────────────────────────

function BodyHeader({
  mode,
  onModeChange,
  onInsertVariable,
  variables,
}: {
  mode: 'edit' | 'preview';
  onModeChange: (next: 'edit' | 'preview') => void;
  onInsertVariable: (name: string) => void;
  variables: ReadonlyArray<EmailTemplateVariable>;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.space[3],
        marginBottom: theme.space[2],
        flexWrap: 'wrap',
      }}
    >
      <p
        style={{
          margin: 0,
          fontSize: theme.type.size.sm,
          fontWeight: theme.type.weight.medium,
          color: theme.color.ink,
        }}
      >
        Body
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2] }}>
        <VariablesPicker
          disabled={mode === 'preview'}
          variables={variables}
          onPick={onInsertVariable}
        />
        <ModeToggle mode={mode} onChange={onModeChange} />
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: 'edit' | 'preview';
  onChange: (next: 'edit' | 'preview') => void;
}) {
  // Two-segment pill — same visual language as SegmentedControl but
  // inline + compact, since we want it sitting tight to the body
  // section header without taking the full row height.
  const seg = (
    active: boolean,
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
  ) => (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        appearance: 'none',
        border: 'none',
        background: active ? theme.color.surface : 'transparent',
        color: active ? theme.color.ink : theme.color.inkMuted,
        padding: `${theme.space[1]}px ${theme.space[3]}px`,
        borderRadius: theme.radius.input,
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: theme.type.size.xs,
        fontWeight: theme.type.weight.semibold,
        display: 'inline-flex',
        alignItems: 'center',
        gap: theme.space[1],
        boxShadow: active ? theme.shadow.card : 'none',
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
    >
      {icon}
      {label}
    </button>
  );
  return (
    <div
      role="tablist"
      style={{
        display: 'inline-flex',
        padding: 2,
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
      }}
    >
      {seg(mode === 'edit', () => onChange('edit'), <Pencil size={12} aria-hidden />, 'Edit')}
      {seg(
        mode === 'preview',
        () => onChange('preview'),
        <Eye size={12} aria-hidden />,
        'Preview',
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Variables picker
// ─────────────────────────────────────────────────────────────────────────────

function VariablesPicker({
  variables,
  onPick,
  disabled,
}: {
  variables: ReadonlyArray<EmailTemplateVariable>;
  onPick: (name: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // Outside-click dismiss.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        style={{
          appearance: 'none',
          border: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
          color: disabled ? theme.color.inkSubtle : theme.color.ink,
          padding: `${theme.space[1]}px ${theme.space[3]}px`,
          borderRadius: theme.radius.input,
          cursor: disabled ? 'default' : 'pointer',
          fontFamily: 'inherit',
          fontSize: theme.type.size.xs,
          fontWeight: theme.type.weight.medium,
          display: 'inline-flex',
          alignItems: 'center',
          gap: theme.space[1],
          opacity: disabled ? 0.5 : 1,
          transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
        }}
      >
        <Braces size={12} aria-hidden /> Insert variable
      </button>
      {open ? (
        <div
          role="menu"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            minWidth: 320,
            maxHeight: 360,
            overflowY: 'auto',
            background: theme.color.surface,
            border: `1px solid ${theme.color.border}`,
            borderRadius: theme.radius.input,
            boxShadow: theme.shadow.overlay,
            zIndex: 100,
            padding: `${theme.space[2]}px 0`,
          }}
        >
          {variables.map((v) => (
            <button
              key={v.name}
              type="button"
              role="menuitem"
              onClick={() => {
                onPick(v.name);
                setOpen(false);
              }}
              style={{
                appearance: 'none',
                width: '100%',
                background: 'transparent',
                border: 'none',
                padding: `${theme.space[2]}px ${theme.space[4]}px`,
                cursor: 'pointer',
                textAlign: 'left',
                fontFamily: 'inherit',
                display: 'flex',
                flexDirection: 'column',
                gap: 2,
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = theme.color.bg;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
              }}
            >
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: theme.space[2],
                }}
              >
                <span
                  style={{
                    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                    fontSize: theme.type.size.xs,
                    background: theme.color.bg,
                    border: `1px solid ${theme.color.border}`,
                    borderRadius: 4,
                    padding: '1px 6px',
                    color: theme.color.ink,
                  }}
                >
                  {`{{${v.name}}}`}
                </span>
                <span
                  style={{
                    fontSize: theme.type.size.sm,
                    fontWeight: theme.type.weight.medium,
                    color: theme.color.ink,
                  }}
                >
                  {v.label}
                </span>
              </span>
              <span
                style={{
                  fontSize: theme.type.size.xs,
                  color: theme.color.inkMuted,
                  lineHeight: theme.type.leading.snug,
                }}
              >
                {v.description}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Body preview — rendered email with sample variable values
// ─────────────────────────────────────────────────────────────────────────────

function BodyPreview({
  templateKey,
  subject,
  body,
}: {
  templateKey: string;
  subject: string;
  body: string;
}) {
  const sampleVars = useMemo(() => sampleVariablesFor(templateKey), [templateKey]);
  const rendered = useMemo(
    () => renderEmail({ subject, bodySyntax: body, variables: sampleVars, shell: 'bare' }),
    [subject, body, sampleVars],
  );
  return (
    <div
      style={{
        background: theme.color.bg,
        border: `1px solid ${theme.color.border}`,
        borderRadius: theme.radius.input,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          borderBottom: `1px solid ${theme.color.border}`,
          background: theme.color.surface,
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
            width: 24,
            height: 24,
            borderRadius: theme.radius.pill,
            background: theme.color.accentBg,
            color: theme.color.accent,
            flexShrink: 0,
          }}
        >
          <Eye size={12} aria-hidden />
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
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
            Subject preview
          </p>
          <p
            style={{
              margin: '2px 0 0',
              fontSize: theme.type.size.sm,
              fontWeight: theme.type.weight.semibold,
              color: theme.color.ink,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {rendered.subject || '—'}
          </p>
        </div>
      </div>
      <div
        style={{
          background: '#F7F6F2',
          padding: `${theme.space[5]}px ${theme.space[5]}px`,
        }}
      >
        <div
          style={{
            background: '#FFFFFF',
            border: `1px solid ${theme.color.border}`,
            borderRadius: 14,
            padding: `${theme.space[6]}px ${theme.space[5]}px`,
            maxWidth: 600,
            margin: '0 auto',
            fontFamily:
              '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
            fontSize: 15,
            color: '#0E1414',
            lineHeight: 1.6,
            // The renderer's `bare` mode returns just the body HTML
            // — we wrap it in the same shell-equivalent surround we
            // ship in production so the preview reads like the real
            // email at full size.
          }}
          dangerouslySetInnerHTML={{ __html: rendered.html }}
        />
        <p
          style={{
            margin: `${theme.space[5]}px 0 0`,
            color: '#7B8285',
            fontSize: 12,
            textAlign: 'center',
          }}
        >
          Venneir Limited
        </p>
      </div>
    </div>
  );
}
