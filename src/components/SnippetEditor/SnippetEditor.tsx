import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';
import { Node as TiptapNode, mergeAttributes } from '@tiptap/core';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List as ListIcon,
  Minus,
  MousePointerClick,
  Palette,
  Underline as UnderlineIcon,
} from 'lucide-react';
import { theme } from '../../theme/index.ts';
import { Button } from '../Button/Button.tsx';
import { BottomSheet } from '../BottomSheet/BottomSheet.tsx';
import { Input } from '../Input/Input.tsx';

// SnippetEditor — TipTap-backed rich text editor for editable email
// templates. Ported from Checkpoint's SnippetEditor.jsx (admin → email
// snippets), adapted to Lounge's design tokens and primitives.
//
// What it does:
//
//   • Renders a TipTap editor that round-trips through the storage
//     syntax via syntaxToHtml / htmlToSyntax — so the value the
//     parent sees matches what's saved to lng_email_templates.body_syntax,
//     and the renderer at send time produces identical HTML.
//
//   • Toolbar: bold / italic / underline / text colour / H2 / H3 /
//     bullet list / horizontal rule / left|center|right align / link /
//     styled button / image. Same feature set as Checkpoint, with
//     Lounge tokens.
//
//   • Custom StyledButton TipTap node so the button preview inside
//     the editor matches what the email sends — bg colour, text
//     colour, border-radius, margin top/bottom all editable via the
//     "Add button" dialog.
//
//   • Link / Image / Button popups are Lounge Dialogs (not the
//     ad-hoc overlays Checkpoint used). Keeps the visual language
//     consistent with the rest of the admin UI.
//
// Public API:
//
//   value     — current body in storage syntax. Empty string fine.
//   onChange  — called with the updated storage syntax on every edit.
//   onCursorVariableInsert — optional; when set, the parent can
//                            push a {{variable}} into the editor via
//                            this ref-style callback. The variables
//                            sidebar (PR 2c) wires this up.
//
// Re-export of syntaxToHtml / htmlToSyntax so PR 2c's preview can
// render the same HTML the editor sees.

// ─────────────────────────────────────────────────────────────────────────────
// Custom Node: Styled Button
// ─────────────────────────────────────────────────────────────────────────────

const StyledButton = TiptapNode.create({
  name: 'styledButton',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-url') ?? '',
      },
      label: {
        default: 'Click here',
        parseHTML: (el) => (el as HTMLElement).textContent?.trim() || 'Click here',
      },
      bgColor: {
        default: '#0E1414',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-bg') ?? '#0E1414',
      },
      textColor: {
        default: '#FFFFFF',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-text-color') ?? '#FFFFFF',
      },
      borderRadius: {
        default: '999',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-radius') ?? '999',
      },
      marginTop: {
        default: '12',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-mt') ?? '12',
      },
      marginBottom: {
        default: '12',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-mb') ?? '12',
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="styled-button"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const { url, bgColor, textColor, borderRadius, marginTop, marginBottom, label, ...rest } =
      HTMLAttributes as {
        url: string;
        bgColor: string;
        textColor: string;
        borderRadius: string;
        marginTop: string;
        marginBottom: string;
        label: string;
      };
    return [
      'span',
      mergeAttributes(rest, {
        'data-type': 'styled-button',
        'data-url': url,
        'data-bg': bgColor,
        'data-text-color': textColor,
        'data-radius': borderRadius,
        'data-mt': marginTop,
        'data-mb': marginBottom,
        style: `display:inline-block;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:default;text-decoration:none;margin:${marginTop}px 0 ${marginBottom}px 0`,
      }),
      label,
    ];
  },
  addNodeView() {
    return ({ node, getPos }) => {
      const url           = (node.attrs.url           as string | null) ?? '';
      const bgColor       = (node.attrs.bgColor       as string | null) ?? '#0E1414';
      const textColor     = (node.attrs.textColor     as string | null) ?? '#FFFFFF';
      const borderRadius  = (node.attrs.borderRadius  as string | null) ?? '999';
      const marginTop     = (node.attrs.marginTop     as string | null) ?? '12';
      const marginBottom  = (node.attrs.marginBottom  as string | null) ?? '12';
      const label         = (node.attrs.label         as string | null) ?? 'Click here';
      const dom = document.createElement('span');
      dom.setAttribute('data-type', 'styled-button');
      dom.setAttribute('data-url', url);
      dom.setAttribute('data-bg', bgColor);
      dom.setAttribute('data-text-color', textColor);
      dom.setAttribute('data-radius', borderRadius);
      dom.setAttribute('data-mt', marginTop);
      dom.setAttribute('data-mb', marginBottom);
      dom.style.cssText = `display:inline-block;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:pointer;text-decoration:none;margin:${marginTop}px 0 ${marginBottom}px 0;user-select:none`;
      dom.textContent = label;
      dom.addEventListener('click', () => {
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos === undefined) return;
        dom.dispatchEvent(
          new CustomEvent('snippet-button-click', {
            bubbles: true,
            detail: { pos, attrs: node.attrs },
          }),
        );
      });
      return { dom };
    };
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Storage syntax ↔ HTML converters
//
// These mirror the parser in src/lib/emailRenderer.ts so the editor
// preview, the renderer's output, and the storage format all agree.
// Keep them in sync; if the storage format gains a feature, update
// emailRenderer.ts AND these functions AND emailRenderer.test.ts.
// ─────────────────────────────────────────────────────────────────────────────

export function syntaxToHtml(text: string): string {
  if (!text) return '<p></p>';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Self-heal old corruption from before the block-separator fix:
  // HR used to walk to bare '---' with no trailing newline, so a
  // divider followed by anything (e.g. **Need to make a change?**)
  // was saved glued to the next line's content. Split any line that
  // starts with --- + non-dash content into a clean HR line plus
  // the remainder, so the editor stops showing literal `---`.
  const rawLines = escaped.split('\n');
  const lines: string[] = [];
  for (const raw of rawLines) {
    const m = raw.match(/^(\s*-{3,})([^-].*)$/);
    if (m && m[1] && m[2] && m[2].trim()) {
      lines.push(m[1].trimStart());
      lines.push(m[2]);
    } else {
      lines.push(raw);
    }
  }
  const htmlLines: string[] = [];
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^---+$/.test(line.trim())) {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      htmlLines.push('<hr>');
      continue;
    }
    if (/^### (.+)$/.test(line)) {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      htmlLines.push(`<h3>${line.slice(4)}</h3>`);
      continue;
    }
    if (/^## (.+)$/.test(line)) {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      htmlLines.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }
    if (/^- (.+)$/.test(line)) {
      if (!inList) {
        htmlLines.push('<ul>');
        inList = true;
      }
      htmlLines.push(`<li>${line.slice(2)}</li>`);
      continue;
    }
    if (/^!\[([^\]]*)\]\((.+?)\)$/.test(line.trim())) {
      if (inList) {
        htmlLines.push('</ul>');
        inList = false;
      }
      const m = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
      if (m) htmlLines.push(`<img src="${m[2]}" alt="${m[1]}">`);
      continue;
    }
    if (inList) {
      htmlLines.push('</ul>');
      inList = false;
    }
    if (line.trim() === '') {
      htmlLines.push('');
      continue;
    }
    htmlLines.push(line);
  }
  if (inList) htmlLines.push('</ul>');

  let html = '';
  let currentP: string[] = [];
  // Counts consecutive empty htmlLines once the previous paragraph
  // has been flushed. The 1st empty line is the block separator;
  // each additional one becomes a `<p></p>` so vertical spacing the
  // user added with extra Enters survives the round trip.
  let emptyStreak = 0;
  const flushEmpties = () => {
    if (emptyStreak > 1) {
      for (let i = 0; i < emptyStreak - 1; i++) html += '<p></p>';
    }
    emptyStreak = 0;
  };
  for (const line of htmlLines) {
    if (line === '') {
      if (currentP.length) {
        html += `<p>${currentP.join('<br>')}</p>`;
        currentP = [];
      }
      emptyStreak++;
      continue;
    }
    if (/^<(h[23]|hr|ul|li|\/ul|img)/.test(line)) {
      if (currentP.length) {
        html += `<p>${currentP.join('<br>')}</p>`;
        currentP = [];
      }
      flushEmpties();
      html += line;
      continue;
    }
    flushEmpties();
    currentP.push(line);
  }
  if (currentP.length) html += `<p>${currentP.join('<br>')}</p>`;

  // Inline formatting + custom button. Buttons must run BEFORE
  // plain links because their URL fragment would otherwise be eaten
  // by the link regex.
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\{color:([^}]+)\}(.+?)\{\/color\}/g, '<span style="color:$1">$2</span>')
    .replace(
      /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
      (
        _: string,
        label: string,
        bg: string | undefined,
        tc: string | undefined,
        rad: string | undefined,
        mt: string | undefined,
        mb: string | undefined,
        url: string,
      ) => {
        const bgColor = bg || '#0E1414';
        const textColor = tc || '#FFFFFF';
        const borderRadius = rad || '999';
        const marginTop = mt || '12';
        const marginBottom = mb || '12';
        return `<span data-type="styled-button" data-url="${url}" data-bg="${bgColor}" data-text-color="${textColor}" data-radius="${borderRadius}" data-mt="${marginTop}" data-mb="${marginBottom}" style="display:inline-block;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:default;text-decoration:none;margin:${marginTop}px 0 ${marginBottom}px 0">${label}</span>`;
      },
    )
    // Backward compat: 3-param button
    .replace(
      /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
      (
        _: string,
        label: string,
        bg: string | undefined,
        tc: string | undefined,
        rad: string | undefined,
        url: string,
      ) => {
        const bgColor = bg || '#0E1414';
        const textColor = tc || '#FFFFFF';
        const borderRadius = rad || '999';
        return `<span data-type="styled-button" data-url="${url}" data-bg="${bgColor}" data-text-color="${textColor}" data-radius="${borderRadius}" data-mt="12" data-mb="12" style="display:inline-block;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:default;text-decoration:none;margin:12px 0">${label}</span>`;
      },
    )
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return html || '<p></p>';
}

export function htmlToSyntax(html: string): string {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;

  // Use the DOM Node type (NodeType.TEXT_NODE === 3) for the walk.
  // Re-imported under an alias because we already use 'TiptapNode'
  // for the editor's Node API at the top of the file.
  const walk = (node: globalThis.Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return wc(node);
    const el = node as Element;
    const tag = el.nodeName;
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '---\n\n';
    if (tag === 'H2') return '## ' + wc(el) + '\n\n';
    if (tag === 'H3') return '### ' + wc(el) + '\n\n';
    if (tag === 'P') {
      const inner = wc(el);
      // Empty paragraphs are visual spacers — encode as a single
      // newline so consecutive empty <p>s survive the round trip.
      // A non-empty paragraph terminates with \n\n (block separator).
      return inner === '' ? '\n' : inner + '\n\n';
    }
    if (tag === 'UL') {
      const lis = Array.from(el.children).map((li) => '- ' + wc(li));
      return lis.join('\n') + '\n\n';
    }
    if (tag === 'LI') return wc(el);
    if (tag === 'STRONG' || tag === 'B') return '**' + wc(el) + '**';
    if (tag === 'EM' || tag === 'I') return '*' + wc(el) + '*';
    if (tag === 'U') return wc(el);
    if (tag === 'A') {
      const href = el.getAttribute('href') ?? '';
      return `[${el.textContent ?? ''}](${href})`;
    }
    if (tag === 'IMG') {
      const src = el.getAttribute('src') ?? '';
      const alt = el.getAttribute('alt') ?? '';
      return `![${alt}](${src})\n\n`;
    }
    if (tag === 'SPAN') {
      if (el.getAttribute('data-type') === 'styled-button') {
        const url = el.getAttribute('data-url') ?? '';
        const label = el.textContent ?? 'Click here';
        const bg = el.getAttribute('data-bg') ?? '#0E1414';
        const tc = el.getAttribute('data-text-color') ?? '#FFFFFF';
        const rad = el.getAttribute('data-radius') ?? '999';
        const mt = el.getAttribute('data-mt') ?? '12';
        const mb = el.getAttribute('data-mb') ?? '12';
        const hasCustom =
          bg !== '#0E1414' || tc !== '#FFFFFF' || rad !== '999' || mt !== '12' || mb !== '12';
        return hasCustom
          ? `[button:${label}|${bg}|${tc}|${rad}|${mt}|${mb}](${url})`
          : `[button:${label}](${url})`;
      }
      const style = el.getAttribute('style') ?? '';
      const colorMatch = style.match(/color:\s*([^;]+)/);
      if (colorMatch && colorMatch[1]) {
        return `{color:${colorMatch[1].trim()}}${wc(el)}{/color}`;
      }
      return wc(el);
    }
    return wc(el);
  };
  const wc = (node: globalThis.Node): string =>
    Array.from(node.childNodes).map(walk).join('');
  // Trim only leading/trailing newlines. Internal runs are
  // intentional: \n\n is a block separator, and each extra \n beyond
  // that represents one preserved empty paragraph.
  return wc(d).replace(/^\n+|\n+$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Toolbar separator
// ─────────────────────────────────────────────────────────────────────────────

function ToolbarSep() {
  return (
    <span
      aria-hidden
      style={{
        width: 1,
        height: 18,
        background: theme.color.border,
        margin: `0 ${theme.space[1]}px`,
        flexShrink: 0,
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-component: Toolbar button
// ─────────────────────────────────────────────────────────────────────────────

function ToolbarButton({
  active = false,
  onClick,
  title,
  disabled = false,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      style={{
        appearance: 'none',
        width: 30,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? theme.color.accentBg : 'transparent',
        border: `1px solid ${active ? theme.color.accent : 'transparent'}`,
        borderRadius: 6,
        cursor: disabled ? 'default' : 'pointer',
        color: active ? theme.color.accent : theme.color.inkMuted,
        opacity: disabled ? 0.4 : 1,
        flexShrink: 0,
        padding: 0,
        transition: `background ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}, color ${theme.motion.duration.fast}ms ${theme.motion.easing.standard}`,
      }}
      onMouseEnter={(e) => {
        if (active || disabled) return;
        e.currentTarget.style.background = theme.color.bg;
        e.currentTarget.style.color = theme.color.ink;
      }}
      onMouseLeave={(e) => {
        if (active || disabled) return;
        e.currentTarget.style.background = 'transparent';
        e.currentTarget.style.color = theme.color.inkMuted;
      }}
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Link popup
// ─────────────────────────────────────────────────────────────────────────────

function LinkDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (args: { url: string; color: string | null }) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('https://');
  const [color, setColor] = useState('');
  const ok = url && url !== 'https://';
  return (
    <BottomSheet
      open
      onClose={onCancel}
      title="Insert link"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ok}
            onClick={() => onConfirm({ url, color: color || null })}
          >
            Insert link
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <Input
          label="URL"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
        />
        <ColorRow
          label="Colour (optional)"
          value={color}
          onChange={setColor}
          allowEmpty
          emptyLabel="Use default link colour"
        />
      </div>
    </BottomSheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Button popup — full styling controls (bg, text, radius, margins) + preview
// ─────────────────────────────────────────────────────────────────────────────

interface ButtonAttrs {
  label: string;
  url: string;
  bgColor: string;
  textColor: string;
  borderRadius: string;
  marginTop: string;
  marginBottom: string;
}

function ButtonDialog({
  initial,
  onConfirm,
  onCancel,
  onDelete,
}: {
  initial?: ButtonAttrs;
  onConfirm: (attrs: ButtonAttrs) => void;
  onCancel: () => void;
  onDelete?: () => void;
}) {
  const isEdit = !!initial;
  const [label, setLabel] = useState(initial?.label ?? 'Click here');
  const [url, setUrl] = useState(initial?.url ?? 'https://');
  const [bgColor, setBgColor] = useState(initial?.bgColor ?? '#0E1414');
  const [textColor, setTextColor] = useState(initial?.textColor ?? '#FFFFFF');
  const [borderRadius, setBorderRadius] = useState(initial?.borderRadius ?? '999');
  const [marginTop, setMarginTop] = useState(initial?.marginTop ?? '12');
  const [marginBottom, setMarginBottom] = useState(initial?.marginBottom ?? '12');
  const ok = label && url && url !== 'https://';

  return (
    <BottomSheet
      open
      onClose={onCancel}
      title={isEdit ? 'Edit button' : 'Add button'}
      description="Buttons render as inline-block tap targets in the email. Tweak the styling below; the preview shows the final result."
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: theme.space[2] }}>
          {isEdit && onDelete ? (
            <Button variant="tertiary" onClick={onDelete}>
              Delete button
            </Button>
          ) : (
            <span />
          )}
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!ok}
              onClick={() =>
                onConfirm({
                  label,
                  url,
                  bgColor,
                  textColor,
                  borderRadius,
                  marginTop,
                  marginBottom,
                })
              }
            >
              {isEdit ? 'Save changes' : 'Add button'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <Input
          label="Button text"
          autoFocus
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <Input
          label="URL"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://"
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <ColorRow label="Background" value={bgColor} onChange={setBgColor} />
          <ColorRow label="Text colour" value={textColor} onChange={setTextColor} />
        </div>
        <SliderRow
          label="Border radius"
          unit="px"
          min={0}
          max={999}
          value={borderRadius}
          onChange={setBorderRadius}
        />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <SliderRow
            label="Margin top"
            unit="px"
            min={0}
            max={40}
            value={marginTop}
            onChange={setMarginTop}
          />
          <SliderRow
            label="Margin bottom"
            unit="px"
            min={0}
            max={40}
            value={marginBottom}
            onChange={setMarginBottom}
          />
        </div>
        <PreviewBlock
          bgColor={bgColor}
          textColor={textColor}
          borderRadius={borderRadius}
          marginTop={marginTop}
          marginBottom={marginBottom}
          label={label || 'Click here'}
        />
      </div>
    </BottomSheet>
  );
}

function PreviewBlock({
  bgColor,
  textColor,
  borderRadius,
  marginTop,
  marginBottom,
  label,
}: {
  bgColor: string;
  textColor: string;
  borderRadius: string;
  marginTop: string;
  marginBottom: string;
  label: string;
}) {
  return (
    <div>
      <Eyebrow>Preview</Eyebrow>
      <div
        style={{
          padding: theme.space[5],
          background: theme.color.bg,
          border: `1px dashed ${theme.color.border}`,
          borderRadius: theme.radius.input,
          textAlign: 'center',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            padding: '12px 28px',
            background: bgColor,
            color: textColor,
            borderRadius: `${borderRadius}px`,
            fontWeight: 600,
            fontSize: 14,
            textDecoration: 'none',
            marginTop: `${marginTop}px`,
            marginBottom: `${marginBottom}px`,
            letterSpacing: '-0.005em',
          }}
        >
          {label}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Image popup
// ─────────────────────────────────────────────────────────────────────────────

function ImageDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (args: { url: string; alt: string }) => void;
  onCancel: () => void;
}) {
  const [url, setUrl] = useState('');
  const [alt, setAlt] = useState('');
  const ok = !!url;
  return (
    <BottomSheet
      open
      onClose={onCancel}
      title="Insert image"
      footer={
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: theme.space[2] }}>
          <Button variant="tertiary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ok} onClick={() => onConfirm({ url, alt })}>
            Insert image
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <Input
          label="Image URL"
          autoFocus
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com/image.png"
        />
        <Input
          label="Alt text (optional)"
          value={alt}
          onChange={(e) => setAlt(e.target.value)}
          placeholder="Describes the image for screen readers"
        />
        {url ? (
          <div
            style={{
              padding: theme.space[3],
              background: theme.color.bg,
              border: `1px dashed ${theme.color.border}`,
              borderRadius: theme.radius.input,
              textAlign: 'center',
            }}
          >
            <img
              src={url}
              alt={alt}
              style={{ maxWidth: '100%', maxHeight: 160, borderRadius: 8 }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = 'none';
              }}
            />
          </div>
        ) : null}
      </div>
    </BottomSheet>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour picker dialog (used standalone for the toolbar text-colour
// button, and inline inside the Link / Button dialogs as ColorRow)
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_PRESETS: readonly string[] = [
  '#0E1414', // ink
  '#5A6266', // inkMuted
  '#B83A2A', // alert
  '#B36815', // warn
  '#28785C', // accent (Lounge dark green)
  '#3B82F6',
  '#8B5CF6',
  '#EC4899',
];

function ColorPickerDialog({
  currentColor,
  onSelect,
  onClose,
}: {
  currentColor: string | null;
  onSelect: (color: string | null) => void;
  onClose: () => void;
}) {
  const [custom, setCustom] = useState(currentColor ?? '');
  return (
    <BottomSheet
      open
      onClose={onClose}
      title="Text colour"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: theme.space[2] }}>
          <Button
            variant="tertiary"
            onClick={() => {
              onSelect(null);
              onClose();
            }}
          >
            Remove colour
          </Button>
          <div style={{ display: 'flex', gap: theme.space[2] }}>
            <Button variant="tertiary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!custom}
              onClick={() => {
                if (custom) {
                  onSelect(custom);
                  onClose();
                }
              }}
            >
              Apply
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <div>
          <Eyebrow>Presets</Eyebrow>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(8, 1fr)',
              gap: theme.space[2],
              marginTop: theme.space[1],
            }}
          >
            {COLOR_PRESETS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => {
                  onSelect(c);
                  onClose();
                }}
                aria-label={`Pick ${c}`}
                style={{
                  width: '100%',
                  aspectRatio: '1',
                  borderRadius: 6,
                  background: c,
                  border:
                    currentColor === c
                      ? `2px solid ${theme.color.accent}`
                      : `1px solid ${theme.color.border}`,
                  cursor: 'pointer',
                  padding: 0,
                }}
              />
            ))}
          </div>
        </div>
        <div>
          <Eyebrow>Custom hex</Eyebrow>
          <div style={{ display: 'flex', gap: theme.space[2], marginTop: theme.space[1] }}>
            <input
              type="color"
              value={custom || '#0E1414'}
              onChange={(e) => setCustom(e.target.value)}
              style={{
                width: 38,
                height: 38,
                border: `1px solid ${theme.color.border}`,
                borderRadius: 6,
                cursor: 'pointer',
                padding: 2,
                background: theme.color.surface,
              }}
            />
            <input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="#000000"
              style={{
                flex: 1,
                padding: `${theme.space[2]}px ${theme.space[3]}px`,
                borderRadius: theme.radius.input,
                border: `1px solid ${theme.color.border}`,
                background: theme.color.surface,
                color: theme.color.ink,
                fontSize: theme.type.size.sm,
                outline: 'none',
                fontFamily: 'inherit',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
          </div>
        </div>
      </div>
    </BottomSheet>
  );
}

// Inline colour swatch + hex input row, used inside Link / Button
// dialogs where a colour is one of several fields.
function ColorRow({
  label,
  value,
  onChange,
  allowEmpty = false,
  emptyLabel,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
}) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[1] }}>
        <input
          type="color"
          value={value || '#0E1414'}
          onChange={(e) => onChange(e.target.value)}
          style={{
            width: 36,
            height: 36,
            border: `1px solid ${theme.color.border}`,
            borderRadius: 6,
            cursor: 'pointer',
            padding: 2,
            background: theme.color.surface,
            flexShrink: 0,
          }}
        />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={allowEmpty ? emptyLabel : '#000000'}
          style={{
            flex: 1,
            minWidth: 0,
            padding: `${theme.space[2]}px ${theme.space[3]}px`,
            borderRadius: theme.radius.input,
            border: `1px solid ${theme.color.border}`,
            background: theme.color.surface,
            color: theme.color.ink,
            fontSize: theme.type.size.sm,
            outline: 'none',
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
          }}
        />
      </div>
    </div>
  );
}

// Slider + numeric label row, used for border-radius / margins.
function SliderRow({
  label,
  unit,
  min,
  max,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[3], marginTop: theme.space[1] }}>
        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{ flex: 1, accentColor: theme.color.accent }}
        />
        <span
          style={{
            fontSize: theme.type.size.sm,
            color: theme.color.inkMuted,
            fontFamily: 'inherit',
            fontVariantNumeric: 'tabular-nums',
            minWidth: 48,
            textAlign: 'right',
          }}
        >
          {value}
          {unit}
        </span>
      </div>
    </div>
  );
}

function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: theme.type.weight.semibold,
        color: theme.color.inkMuted,
        textTransform: 'uppercase',
        letterSpacing: theme.type.tracking.wide,
      }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API + main component
// ─────────────────────────────────────────────────────────────────────────────

export interface SnippetEditorProps {
  /** Body in storage syntax. */
  value: string;
  /** Called on every edit with the new storage syntax. */
  onChange: (next: string) => void;
  /** Optional placeholder shown in the empty editor. */
  placeholder?: string;
  /** Forwarded to the internal editor for imperative control by the
   * parent (e.g. variables sidebar inserting {{var}} at cursor). */
  editorRef?: { current: Editor | null };
}

export function SnippetEditor({
  value,
  onChange,
  placeholder,
  editorRef,
}: SnippetEditorProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const [buttonOpen, setButtonOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  // editingButton: set when the user clicks an existing button node in
  // the editor. Stores the document position + current attrs so the
  // edit dialog can pre-fill and update/delete the right node.
  const [editingButton, setEditingButton] = useState<{
    pos: number;
    attrs: ButtonAttrs;
  } | null>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          blockquote: false,
          codeBlock: false,
          code: false,
          strike: false,
          // Inline margins on every block, byte-for-byte identical
          // to the email renderer's BLOCK_MARGIN_BOTTOM. Editor
          // preview = sent email; what you see is what your patient
          // sees. One consistent paragraph gap, no asymmetry between
          // headings, paragraphs, or dividers.
          paragraph: { HTMLAttributes: { style: 'margin:0 0 8px 0' } },
          heading: { HTMLAttributes: { style: 'margin:0 0 8px 0' } },
          horizontalRule: {
            HTMLAttributes: {
              style: 'border:none;border-top:1px solid #E5E2DC;margin:0 0 8px 0',
            },
          },
          bulletList: { HTMLAttributes: { style: 'margin:0 0 8px 0' } },
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
        }),
        Underline,
        TextStyle,
        Color,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Image.configure({
          inline: false,
          allowBase64: false,
          HTMLAttributes: {
            style: 'max-width:100%;border-radius:8px;margin:0 0 8px 0;display:block',
          },
        }),
        StyledButton,
      ],
      content: syntaxToHtml(value || ''),
      onUpdate: ({ editor }) => {
        const syntax = htmlToSyntax(editor.getHTML());
        onChange(syntax);
      },
      editorProps: {
        attributes: {
          style: `outline:none;min-height:220px;font-size:${theme.type.size.sm};line-height:${theme.type.leading.relaxed};color:${theme.color.ink};font-family:inherit`,
        },
        handlePaste: (view, event) => {
          // Pasting rich text from another app drags in styles we
          // don't support and visual fragments that round-trip
          // poorly. Force plain-text paste — if the user wants
          // formatting they can apply it explicitly.
          const text = event.clipboardData?.getData('text/plain');
          if (text) {
            event.preventDefault();
            view.dispatch(view.state.tr.insertText(text));
            return true;
          }
          return false;
        },
      },
    },
    [],
  );

  // Forward the editor instance to the parent's ref.
  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = editor ?? null;
    return () => {
      if (editorRef) editorRef.current = null;
    };
  }, [editor, editorRef]);

  // Listen for click events dispatched by the styledButton node view.
  // When a button is clicked in the editor, open the edit dialog
  // pre-filled with its current attrs.
  useEffect(() => {
    const el = editorWrapperRef.current;
    if (!el) return;
    const handler = (e: Event) => {
      const { pos, attrs } = (e as CustomEvent<{ pos: number; attrs: ButtonAttrs }>).detail;
      setEditingButton({ pos, attrs });
    };
    el.addEventListener('snippet-button-click', handler);
    return () => el.removeEventListener('snippet-button-click', handler);
  }, []);

  // Sync external value changes (e.g. version restore from history).
  useEffect(() => {
    if (!editor) return;
    const currentSyntax = htmlToSyntax(editor.getHTML());
    if (currentSyntax !== value && value !== undefined) {
      editor.commands.setContent(syntaxToHtml(value || ''));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  if (!editor) return null;

  const currentColor: string | null =
    (editor.getAttributes('textStyle')?.color as string | undefined) ?? null;

  const confirmLink = ({ url, color }: { url: string; color: string | null }) => {
    if (!editor || !url) {
      setLinkOpen(false);
      return;
    }
    const { from, to } = editor.state.selection;
    if (from === to) {
      // Nothing selected — insert as a fresh "Link" word so the
      // user can rename it inline. Better than blocking the
      // insertion and forcing them to select first.
      editor
        .chain()
        .focus()
        .insertContent(
          `<a href="${url}"${color ? ` style="color:${color}"` : ''}>Link</a>`,
        )
        .run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
    setLinkOpen(false);
  };

  const confirmButton = (attrs: ButtonAttrs) => {
    if (!editor || !attrs.url) {
      setButtonOpen(false);
      return;
    }
    editor
      .chain()
      .focus()
      .insertContent({
        type: 'styledButton',
        attrs: {
          url: attrs.url,
          label: attrs.label,
          bgColor: attrs.bgColor,
          textColor: attrs.textColor,
          borderRadius: attrs.borderRadius,
          marginTop: attrs.marginTop,
          marginBottom: attrs.marginBottom,
        },
      })
      .run();
    setButtonOpen(false);
  };

  const confirmEditButton = (newAttrs: ButtonAttrs) => {
    if (!editor || editingButton === null) return;
    const { pos } = editingButton;
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'styledButton') {
      setEditingButton(null);
      return;
    }
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        url: newAttrs.url,
        label: newAttrs.label,
        bgColor: newAttrs.bgColor,
        textColor: newAttrs.textColor,
        borderRadius: newAttrs.borderRadius,
        marginTop: newAttrs.marginTop,
        marginBottom: newAttrs.marginBottom,
      }),
    );
    setEditingButton(null);
  };

  const deleteEditButton = () => {
    if (!editor || editingButton === null) return;
    const { pos } = editingButton;
    const node = editor.state.doc.nodeAt(pos);
    if (node) {
      editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    }
    setEditingButton(null);
  };

  const confirmImage = ({ url, alt }: { url: string; alt: string }) => {
    if (!editor || !url) {
      setImageOpen(false);
      return;
    }
    editor.chain().focus().setImage({ src: url, alt: alt || '' }).run();
    setImageOpen(false);
  };

  return (
    <div ref={editorWrapperRef}>
      {/* Toolbar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: `${theme.space[1]}px ${theme.space[2]}px`,
          background: theme.color.bg,
          border: `1px solid ${theme.color.border}`,
          borderRadius: `${theme.radius.input}px ${theme.radius.input}px 0 0`,
          borderBottom: 'none',
          flexWrap: 'wrap',
        }}
      >
        <ToolbarButton
          title="Bold (⌘B)"
          active={editor.isActive('bold')}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <Bold size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          title="Italic (⌘I)"
          active={editor.isActive('italic')}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <Italic size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          title="Underline (⌘U)"
          active={editor.isActive('underline')}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <UnderlineIcon size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          title="Text colour"
          active={!!currentColor}
          onClick={() => setColorOpen(true)}
        >
          <span style={{ position: 'relative', display: 'inline-flex' }}>
            <Palette size={14} aria-hidden />
            {currentColor ? (
              <span
                aria-hidden
                style={{
                  position: 'absolute',
                  left: -2,
                  right: -2,
                  bottom: -3,
                  height: 2,
                  borderRadius: 1,
                  background: currentColor,
                }}
              />
            ) : null}
          </span>
        </ToolbarButton>

        <ToolbarSep />

        <ToolbarButton
          title="Heading 2"
          active={editor.isActive('heading', { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          <span style={{ fontSize: 11, fontWeight: 700 }}>H2</span>
        </ToolbarButton>
        <ToolbarButton
          title="Heading 3"
          active={editor.isActive('heading', { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          <span style={{ fontSize: 11, fontWeight: 700 }}>H3</span>
        </ToolbarButton>
        <ToolbarButton
          title="Bullet list"
          active={editor.isActive('bulletList')}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          <ListIcon size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          title="Divider"
          active={false}
          onClick={() => editor.chain().focus().setHorizontalRule().run()}
        >
          <Minus size={14} aria-hidden />
        </ToolbarButton>

        <ToolbarSep />

        <ToolbarButton
          title="Align left"
          active={editor.isActive({ textAlign: 'left' })}
          onClick={() => editor.chain().focus().setTextAlign('left').run()}
        >
          <AlignLeft size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          title="Align centre"
          active={editor.isActive({ textAlign: 'center' })}
          onClick={() => editor.chain().focus().setTextAlign('center').run()}
        >
          <AlignCenter size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton
          title="Align right"
          active={editor.isActive({ textAlign: 'right' })}
          onClick={() => editor.chain().focus().setTextAlign('right').run()}
        >
          <AlignRight size={14} aria-hidden />
        </ToolbarButton>

        <ToolbarSep />

        <ToolbarButton
          title="Insert link"
          active={editor.isActive('link')}
          onClick={() => setLinkOpen(true)}
        >
          <LinkIcon size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton title="Add button" onClick={() => setButtonOpen(true)}>
          <MousePointerClick size={14} aria-hidden />
        </ToolbarButton>
        <ToolbarButton title="Insert image" onClick={() => setImageOpen(true)}>
          <ImageIcon size={14} aria-hidden />
        </ToolbarButton>
      </div>

      {/* Editor body */}
      <div
        style={{
          background: theme.color.surface,
          border: `1px solid ${theme.color.border}`,
          borderRadius: `0 0 ${theme.radius.input}px ${theme.radius.input}px`,
          padding: `${theme.space[3]}px ${theme.space[4]}px`,
          minHeight: 240,
          cursor: 'text',
        }}
        onClick={() => editor.chain().focus().run()}
      >
        <EditorContent editor={editor} placeholder={placeholder} />
      </div>

      {linkOpen ? <LinkDialog onConfirm={confirmLink} onCancel={() => setLinkOpen(false)} /> : null}
      {buttonOpen ? (
        <ButtonDialog onConfirm={confirmButton} onCancel={() => setButtonOpen(false)} />
      ) : null}
      {editingButton ? (
        <ButtonDialog
          initial={editingButton.attrs}
          onConfirm={confirmEditButton}
          onCancel={() => setEditingButton(null)}
          onDelete={deleteEditButton}
        />
      ) : null}
      {imageOpen ? (
        <ImageDialog onConfirm={confirmImage} onCancel={() => setImageOpen(false)} />
      ) : null}
      {colorOpen ? (
        <ColorPickerDialog
          currentColor={currentColor}
          onSelect={(c) => {
            if (c) editor.chain().focus().setColor(c).run();
            else editor.chain().focus().unsetColor().run();
          }}
          onClose={() => setColorOpen(false)}
        />
      ) : null}
    </div>
  );
}
