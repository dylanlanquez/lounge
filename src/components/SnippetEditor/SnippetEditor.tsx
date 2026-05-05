import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Image from '@tiptap/extension-image';
import { Node as TiptapNode, Extension, mergeAttributes } from '@tiptap/core';
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
import { EMAIL_ICONS, EMAIL_ICON_LIST } from '../../lib/emailIcons.ts';

// ─────────────────────────────────────────────────────────────────────────────
// FontWeight extension — extends TextStyle so font-weight can be set
// alongside color on the same span, avoiding nested mark soup.
// ─────────────────────────────────────────────────────────────────────────────

const FontWeightExtension = Extension.create({
  name: 'fontWeightExtension',
  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontWeight: {
            default: null,
            parseHTML: (el) => (el as HTMLElement).style.fontWeight || null,
            renderHTML: (attrs) => {
              if (!attrs.fontWeight) return {};
              return { style: `font-weight:${attrs.fontWeight as string}` };
            },
          },
        },
      },
    ];
  },
});

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
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-label') || (el as HTMLElement).textContent?.trim() || 'Click here',
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
      borderWidth: {
        default: '0',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-bw') ?? '0',
      },
      borderColor: {
        default: '#0E1414',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-bc') ?? '#0E1414',
      },
      iconName: {
        default: '',
        parseHTML: (el) => (el as HTMLElement).getAttribute('data-icon') ?? '',
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-type="styled-button"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    const {
      url, bgColor, textColor, borderRadius, marginTop, marginBottom,
      label, borderWidth, borderColor, iconName, ...rest
    } = HTMLAttributes as {
      url: string; bgColor: string; textColor: string; borderRadius: string;
      marginTop: string; marginBottom: string; label: string;
      borderWidth: string; borderColor: string; iconName: string;
    };
    const bwNum = Number(borderWidth || '0');
    const borderStyle = bwNum > 0 ? `;border:${bwNum}px solid ${borderColor}` : '';
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
        'data-label': label,
        'data-bw': borderWidth || '0',
        'data-bc': borderColor || '#0E1414',
        'data-icon': iconName || '',
        style: `display:inline-block;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:default;text-decoration:none;margin:${marginTop}px 0 ${marginBottom}px 0${borderStyle}`,
      }),
      label,
    ];
  },
  addNodeView() {
    return ({ node, getPos }) => {
      const url          = (node.attrs.url          as string | null) ?? '';
      const bgColor      = (node.attrs.bgColor      as string | null) ?? '#0E1414';
      const textColor    = (node.attrs.textColor    as string | null) ?? '#FFFFFF';
      const borderRadius = (node.attrs.borderRadius as string | null) ?? '999';
      const marginTop    = (node.attrs.marginTop    as string | null) ?? '12';
      const marginBottom = (node.attrs.marginBottom as string | null) ?? '12';
      const label        = (node.attrs.label        as string | null) ?? 'Click here';
      const borderWidth  = (node.attrs.borderWidth  as string | null) ?? '0';
      const borderColor  = (node.attrs.borderColor  as string | null) ?? '#0E1414';
      const iconName     = (node.attrs.iconName     as string | null) ?? '';

      const bwNum = Number(borderWidth);
      const borderStyleStr = bwNum > 0 ? `border:${bwNum}px solid ${borderColor};` : '';

      const dom = document.createElement('span');
      dom.setAttribute('data-type', 'styled-button');
      dom.setAttribute('data-url', url);
      dom.setAttribute('data-bg', bgColor);
      dom.setAttribute('data-text-color', textColor);
      dom.setAttribute('data-radius', borderRadius);
      dom.setAttribute('data-mt', marginTop);
      dom.setAttribute('data-mb', marginBottom);
      dom.setAttribute('data-bw', borderWidth);
      dom.setAttribute('data-bc', borderColor);
      dom.setAttribute('data-icon', iconName);
      dom.style.cssText = `display:inline-flex;align-items:center;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:pointer;text-decoration:none;margin:${marginTop}px 0 ${marginBottom}px 0;user-select:none;${borderStyleStr}`;

      if (iconName && EMAIL_ICONS[iconName]) {
        const iconSpan = document.createElement('span');
        iconSpan.style.cssText = 'display:inline-flex;flex-shrink:0;margin-right:6px';
        iconSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="${textColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EMAIL_ICONS[iconName]}</svg>`;
        dom.appendChild(iconSpan);
      }
      const labelSpan = document.createElement('span');
      labelSpan.textContent = label;
      dom.appendChild(labelSpan);

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

// Regex that matches a full-line button. Parameter character class
// [^|<>\]"(]* excludes every HTML-structural character so it can never
// match across tag boundaries or paragraph separators.
// Group indices: 1=label, 2=bg, 3=tc, 4=rad, 5=mt, 6=mb,
//               7=bw, 8=bc, 9=icon  (7-9 optional), 10=url
const BUTTON_LINE_RE =
  /^\[button:(.+?)(?:\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)(?:\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*))?)?\]\(([^)]+)\)$/;

function buildEditorButtonSpan(m: RegExpMatchArray): string {
  const label        = m[1]  ?? '';
  const bgColor      = m[2]  || '#0E1414';
  const textColor    = m[3]  || '#FFFFFF';
  const borderRadius = m[4]  || '999';
  const marginTop    = m[5]  || '12';
  const marginBottom = m[6]  || '12';
  const borderWidth  = m[7]  || '0';
  const borderColor  = m[8]  || '#0E1414';
  const iconName     = m[9]  || '';
  const url          = m[10] ?? '';
  const bwNum = Number(borderWidth);
  const borderStr = bwNum > 0 ? `;border:${bwNum}px solid ${borderColor}` : '';
  const iconHtml = iconName && EMAIL_ICONS[iconName]
    ? `<span style="display:inline-block;margin-right:5px;vertical-align:middle"><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${textColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EMAIL_ICONS[iconName]}</svg></span>`
    : '';
  return `<span data-type="styled-button" data-label="${label}" data-url="${url}" data-bg="${bgColor}" data-text-color="${textColor}" data-radius="${borderRadius}" data-mt="${marginTop}" data-mb="${marginBottom}" data-bw="${borderWidth}" data-bc="${borderColor}" data-icon="${iconName}" style="display:inline-block;padding:8px 20px;background:${bgColor};color:${textColor};border-radius:${borderRadius}px;font-weight:600;font-size:13px;cursor:default;text-decoration:none;margin:${marginTop}px 0 ${marginBottom}px 0${borderStr}">${iconHtml}${label}</span>`;
}

export function syntaxToHtml(text: string): string {
  if (!text) return '<p></p>';
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Self-heal old corruption from before the block-separator fix.
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
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      htmlLines.push('<hr>');
      continue;
    }
    if (/^#### (.+)$/.test(line)) {
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      htmlLines.push(`<h4>${line.slice(5)}</h4>`);
      continue;
    }
    if (/^### (.+)$/.test(line)) {
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      htmlLines.push(`<h3>${line.slice(4)}</h3>`);
      continue;
    }
    if (/^## (.+)$/.test(line)) {
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      htmlLines.push(`<h2>${line.slice(3)}</h2>`);
      continue;
    }
    if (/^# (.+)$/.test(line)) {
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      htmlLines.push(`<h1>${line.slice(2)}</h1>`);
      continue;
    }
    if (/^- (.+)$/.test(line)) {
      if (!inList) { htmlLines.push('<ul>'); inList = true; }
      htmlLines.push(`<li>${line.slice(2)}</li>`);
      continue;
    }
    if (/^!\[([^\]]*)\]\((.+?)\)$/.test(line.trim())) {
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      const m = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
      if (m) htmlLines.push(`<img src="${m[2]}" alt="${m[1]}">`);
      continue;
    }
    // Full-line button: convert at the text level so that the inline
    // regex chain never runs on assembled multi-paragraph HTML (which
    // would allow greedy parameter groups to match across <p> tags).
    // Trim defensively: a trailing \r (CRLF input) or space would break
    // the $ anchor even though the syntax itself is valid.
    const btnM = line.trim().match(BUTTON_LINE_RE);
    if (btnM) {
      if (inList) { htmlLines.push('</ul>'); inList = false; }
      htmlLines.push(buildEditorButtonSpan(btnM));
      continue;
    }
    if (inList) { htmlLines.push('</ul>'); inList = false; }
    if (line.trim() === '') { htmlLines.push(''); continue; }
    htmlLines.push(line);
  }
  if (inList) htmlLines.push('</ul>');

  let html = '';
  let currentP: string[] = [];
  let emptyStreak = 0;
  const flushEmpties = () => {
    if (emptyStreak > 1) {
      for (let i = 0; i < emptyStreak - 1; i++) html += '<p></p>';
    }
    emptyStreak = 0;
  };
  for (const line of htmlLines) {
    if (line === '') {
      if (currentP.length) { html += `<p>${currentP.join('<br>')}</p>`; currentP = []; }
      emptyStreak++;
      continue;
    }
    if (/^<(h[1-4]|hr|ul|li|\/ul|img)/.test(line)) {
      if (currentP.length) { html += `<p>${currentP.join('<br>')}</p>`; currentP = []; }
      flushEmpties();
      html += line;
      continue;
    }
    flushEmpties();
    currentP.push(line);
  }
  if (currentP.length) html += `<p>${currentP.join('<br>')}</p>`;

  // Inline formatting only. Button syntax is resolved at the line level
  // above; running a button regex on assembled multi-paragraph HTML is
  // unsafe because the greedy parameter groups can match across </p><p>
  // boundaries and consume entire paragraphs of content.
  html = html
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>')
    .replace(/\{w:([^}]+)\}(.+?)\{\/w\}/g, '<span style="font-weight:$1">$2</span>')
    .replace(/\{color:([^}]+)\}(.+?)\{\/color\}/g, '<span style="color:$1">$2</span>')
    .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  return html || '<p></p>';
}

export function htmlToSyntax(html: string): string {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;

  const walk = (node: globalThis.Node): string => {
    if (node.nodeType === 3) return node.textContent ?? '';
    if (node.nodeType !== 1) return wc(node);
    const el = node as Element;
    const tag = el.nodeName;
    if (tag === 'BR') return '\n';
    if (tag === 'HR') return '---\n\n';
    if (tag === 'H1') return '# ' + wc(el) + '\n\n';
    if (tag === 'H2') return '## ' + wc(el) + '\n\n';
    if (tag === 'H3') return '### ' + wc(el) + '\n\n';
    if (tag === 'H4') return '#### ' + wc(el) + '\n\n';
    if (tag === 'P') {
      const inner = wc(el);
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
        const url   = el.getAttribute('data-url') ?? '';
        const label = el.getAttribute('data-label') || el.textContent?.trim() || 'Click here';
        const bg    = el.getAttribute('data-bg') ?? '#0E1414';
        const tc    = el.getAttribute('data-text-color') ?? '#FFFFFF';
        const rad   = el.getAttribute('data-radius') ?? '999';
        const mt    = el.getAttribute('data-mt') ?? '12';
        const mb    = el.getAttribute('data-mb') ?? '12';
        const bw    = el.getAttribute('data-bw') ?? '0';
        const bc    = el.getAttribute('data-bc') ?? '#0E1414';
        const icon  = el.getAttribute('data-icon') ?? '';
        const isDefault =
          bg === '#0E1414' && tc === '#FFFFFF' && rad === '999' &&
          mt === '12' && mb === '12' && bw === '0' && bc === '#0E1414' && icon === '';
        return isDefault
          ? `[button:${label}](${url})`
          : `[button:${label}|${bg}|${tc}|${rad}|${mt}|${mb}|${bw}|${bc}|${icon}](${url})`;
      }
      const style = el.getAttribute('style') ?? '';
      const weightMatch = style.match(/(?:^|;)\s*font-weight:\s*([^;]+)/);
      const colorMatch  = style.match(/(?:^|;)\s*color:\s*([^;]+)/);
      let inner = wc(el);
      if (weightMatch?.[1]) inner = `{w:${weightMatch[1].trim()}}${inner}{/w}`;
      if (colorMatch?.[1])  inner = `{color:${colorMatch[1].trim()}}${inner}{/color}`;
      return inner;
    }
    return wc(el);
  };
  const wc = (node: globalThis.Node): string =>
    Array.from(node.childNodes).map(walk).join('');
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
  initial,
  onConfirm,
  onCancel,
  onRemove,
}: {
  initial?: { url: string };
  onConfirm: (args: { url: string; color: string | null }) => void;
  onCancel: () => void;
  onRemove?: () => void;
}) {
  const isEdit = !!initial;
  const [url, setUrl] = useState(initial?.url ?? 'https://');
  const [color, setColor] = useState('');
  const ok = url && url !== 'https://';
  return (
    <BottomSheet
      open
      onClose={onCancel}
      title={isEdit ? 'Edit link' : 'Insert link'}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: theme.space[2] }}>
          {isEdit && onRemove ? (
            <Button variant="tertiary" onClick={onRemove}>
              Remove link
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
              onClick={() => onConfirm({ url, color: color || null })}
            >
              {isEdit ? 'Save link' : 'Insert link'}
            </Button>
          </div>
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
// Button popup — full styling controls + border + icon picker
// ─────────────────────────────────────────────────────────────────────────────

interface ButtonAttrs {
  label: string;
  url: string;
  bgColor: string;
  textColor: string;
  borderRadius: string;
  marginTop: string;
  marginBottom: string;
  borderWidth: string;
  borderColor: string;
  iconName: string;
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
  const [label,        setLabel]        = useState(initial?.label        ?? 'Click here');
  const [url,          setUrl]          = useState(initial?.url          ?? 'https://');
  const [bgColor,      setBgColor]      = useState(initial?.bgColor      ?? '#0E1414');
  const [textColor,    setTextColor]    = useState(initial?.textColor    ?? '#FFFFFF');
  const [borderRadius, setBorderRadius] = useState(initial?.borderRadius ?? '999');
  const [marginTop,    setMarginTop]    = useState(initial?.marginTop    ?? '12');
  const [marginBottom, setMarginBottom] = useState(initial?.marginBottom ?? '12');
  const [borderWidth,  setBorderWidth]  = useState(initial?.borderWidth  ?? '0');
  const [borderColor,  setBorderColor]  = useState(initial?.borderColor  ?? '#0E1414');
  const [iconName,     setIconName]     = useState(initial?.iconName     ?? '');
  const ok = label && url && url !== 'https://';

  return (
    <BottomSheet
      open
      onClose={onCancel}
      title={isEdit ? 'Edit button' : 'Add button'}
      description="Buttons render as tap targets in the email. Tweak the styling below; the preview shows the final result."
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
                onConfirm({ label, url, bgColor, textColor, borderRadius, marginTop, marginBottom, borderWidth, borderColor, iconName })
              }
            >
              {isEdit ? 'Save changes' : 'Add button'}
            </Button>
          </div>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: theme.space[3] }}>
        <Input label="Button text" autoFocus value={label} onChange={(e) => setLabel(e.target.value)} />
        <Input label="URL" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" />

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <ColorRow label="Background" value={bgColor} onChange={setBgColor} />
          <ColorRow label="Text colour" value={textColor} onChange={setTextColor} />
        </div>

        {/* Border radius — slider capped at 24 for usability, Pill button forces 999 */}
        <div>
          <Eyebrow>Border radius</Eyebrow>
          <div style={{ display: 'flex', alignItems: 'center', gap: theme.space[2], marginTop: theme.space[1] }}>
            <input
              type="range"
              min={0}
              max={24}
              value={borderRadius === '999' ? '24' : String(Math.min(Number(borderRadius), 24))}
              onChange={(e) => setBorderRadius(e.target.value)}
              style={{ flex: 1, accentColor: theme.color.accent }}
            />
            <span style={{ fontSize: theme.type.size.sm, color: theme.color.inkMuted, fontVariantNumeric: 'tabular-nums', minWidth: 38, textAlign: 'right' }}>
              {borderRadius === '999' ? 'Pill' : `${borderRadius}px`}
            </span>
            <button
              type="button"
              onClick={() => setBorderRadius('999')}
              style={{
                padding: '3px 10px',
                borderRadius: 6,
                border: `1px solid ${borderRadius === '999' ? theme.color.accent : theme.color.border}`,
                background: borderRadius === '999' ? theme.color.accentBg : 'transparent',
                color: borderRadius === '999' ? theme.color.accent : theme.color.inkMuted,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                flexShrink: 0,
                fontFamily: 'inherit',
              }}
            >
              Pill
            </button>
          </div>
        </div>

        {/* Border width + color */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <SliderRow
            label="Border width"
            unit="px"
            min={0}
            max={8}
            value={borderWidth}
            onChange={setBorderWidth}
          />
          <ColorRow label="Border colour" value={borderColor} onChange={setBorderColor} />
        </div>

        {/* Icon picker */}
        <div>
          <Eyebrow>Icon (optional)</Eyebrow>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(7, 1fr)',
              gap: 6,
              marginTop: theme.space[1],
              maxHeight: 220,
              overflowY: 'auto',
              padding: '2px 0',
            }}
          >
            {/* None option */}
            <button
              type="button"
              onClick={() => setIconName('')}
              title="No icon"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                padding: '6px 4px',
                border: `1px solid ${iconName === '' ? theme.color.accent : theme.color.border}`,
                background: iconName === '' ? theme.color.accentBg : 'transparent',
                borderRadius: 8,
                cursor: 'pointer',
                color: iconName === '' ? theme.color.accent : theme.color.inkMuted,
                minWidth: 0,
              }}
            >
              <span style={{ fontSize: 14, lineHeight: 1, fontWeight: 600 }}>—</span>
              <span style={{ fontSize: 9, textAlign: 'center' }}>None</span>
            </button>

            {EMAIL_ICON_LIST.map(({ name, label: iconLabel }) => (
              <button
                key={name}
                type="button"
                onClick={() => setIconName(name)}
                title={iconLabel}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 3,
                  padding: '6px 4px',
                  border: `1px solid ${iconName === name ? theme.color.accent : theme.color.border}`,
                  background: iconName === name ? theme.color.accentBg : 'transparent',
                  borderRadius: 8,
                  cursor: 'pointer',
                  color: iconName === name ? theme.color.accent : theme.color.inkMuted,
                  minWidth: 0,
                }}
              >
                <span
                  style={{ display: 'flex', color: 'inherit' }}
                  dangerouslySetInnerHTML={{
                    __html: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EMAIL_ICONS[name] ?? ''}</svg>`,
                  }}
                />
                <span style={{ fontSize: 9, textAlign: 'center', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', width: '100%' }}>
                  {iconLabel}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Margins */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: theme.space[3] }}>
          <SliderRow label="Margin top"    unit="px" min={0} max={40} value={marginTop}    onChange={setMarginTop}    />
          <SliderRow label="Margin bottom" unit="px" min={0} max={40} value={marginBottom} onChange={setMarginBottom} />
        </div>

        <PreviewBlock
          bgColor={bgColor}
          textColor={textColor}
          borderRadius={borderRadius}
          marginTop={marginTop}
          marginBottom={marginBottom}
          borderWidth={borderWidth}
          borderColor={borderColor}
          iconName={iconName}
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
  borderWidth,
  borderColor,
  iconName,
  label,
}: {
  bgColor: string;
  textColor: string;
  borderRadius: string;
  marginTop: string;
  marginBottom: string;
  borderWidth: string;
  borderColor: string;
  iconName: string;
  label: string;
}) {
  const rad = borderRadius === '999' ? 9999 : Number(borderRadius);
  const bwNum = Number(borderWidth);
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
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '12px 28px',
            background: bgColor,
            color: textColor,
            borderRadius: `${rad}px`,
            fontWeight: 600,
            fontSize: 14,
            textDecoration: 'none',
            marginTop: `${marginTop}px`,
            marginBottom: `${marginBottom}px`,
            letterSpacing: '-0.005em',
            border: bwNum > 0 ? `${bwNum}px solid ${borderColor}` : 'none',
          }}
        >
          {iconName && EMAIL_ICONS[iconName] ? (
            <span
              style={{ display: 'inline-flex', flexShrink: 0 }}
              dangerouslySetInnerHTML={{
                __html: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${textColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${EMAIL_ICONS[iconName]}</svg>`,
              }}
            />
          ) : null}
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
// Colour picker dialog
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_PRESETS: readonly string[] = [
  '#0E1414',
  '#5A6266',
  '#B83A2A',
  '#B36815',
  '#28785C',
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
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  editorRef?: { current: Editor | null };
}

export function SnippetEditor({
  value,
  onChange,
  placeholder,
  editorRef,
}: SnippetEditorProps) {
  const [linkOpen,      setLinkOpen]      = useState(false);
  const [linkInitial,   setLinkInitial]   = useState<{ url: string } | null>(null);
  const [buttonOpen,    setButtonOpen]    = useState(false);
  const [imageOpen,     setImageOpen]     = useState(false);
  const [colorOpen,     setColorOpen]     = useState(false);
  const [editingButton, setEditingButton] = useState<{ pos: number; attrs: ButtonAttrs } | null>(null);
  const editorWrapperRef = useRef<HTMLDivElement>(null);

  const editor = useEditor(
    {
      extensions: [
        StarterKit.configure({
          blockquote: false,
          codeBlock: false,
          code: false,
          strike: false,
          paragraph:       { HTMLAttributes: { style: 'margin:0 0 8px 0' } },
          heading:         { HTMLAttributes: { style: 'margin:0 0 8px 0' } },
          horizontalRule:  { HTMLAttributes: { style: 'border:none;border-top:1px solid #E5E2DC;margin:0 0 8px 0' } },
          bulletList:      { HTMLAttributes: { style: 'margin:0 0 8px 0' } },
        }),
        Link.configure({
          openOnClick: false,
          HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
        }),
        Underline,
        TextStyle,
        Color,
        FontWeightExtension,
        TextAlign.configure({ types: ['heading', 'paragraph'] }),
        Image.configure({
          inline: false,
          allowBase64: false,
          HTMLAttributes: { style: 'max-width:100%;border-radius:8px;margin:0 0 8px 0;display:block' },
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

  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = editor ?? null;
    return () => { if (editorRef) editorRef.current = null; };
  }, [editor, editorRef]);

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
  const currentFontWeight: string | undefined =
    editor.getAttributes('textStyle')?.fontWeight as string | undefined;

  const openLinkDialog = () => {
    if (editor.isActive('link')) {
      const href = (editor.getAttributes('link').href as string | undefined) ?? '';
      setLinkInitial({ url: href });
    } else {
      setLinkInitial(null);
    }
    setLinkOpen(true);
  };

  const confirmLink = ({ url, color }: { url: string; color: string | null }) => {
    if (!editor || !url) { setLinkOpen(false); return; }
    const { from, to } = editor.state.selection;
    if (from === to) {
      editor.chain().focus().insertContent(
        `<a href="${url}"${color ? ` style="color:${color}"` : ''}>Link</a>`,
      ).run();
    } else {
      editor.chain().focus().setLink({ href: url }).run();
    }
    setLinkOpen(false);
    setLinkInitial(null);
  };

  const removeLink = () => {
    editor?.chain().focus().unsetLink().run();
    setLinkOpen(false);
    setLinkInitial(null);
  };

  const confirmButton = (attrs: ButtonAttrs) => {
    if (!editor || !attrs.url) { setButtonOpen(false); return; }
    editor.chain().focus().insertContent({
      type: 'styledButton',
      attrs: {
        url:          attrs.url,
        label:        attrs.label,
        bgColor:      attrs.bgColor,
        textColor:    attrs.textColor,
        borderRadius: attrs.borderRadius,
        marginTop:    attrs.marginTop,
        marginBottom: attrs.marginBottom,
        borderWidth:  attrs.borderWidth,
        borderColor:  attrs.borderColor,
        iconName:     attrs.iconName,
      },
    }).run();
    setButtonOpen(false);
  };

  const confirmEditButton = (newAttrs: ButtonAttrs) => {
    if (!editor || editingButton === null) return;
    const { pos } = editingButton;
    const node = editor.state.doc.nodeAt(pos);
    if (!node || node.type.name !== 'styledButton') { setEditingButton(null); return; }
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        url:          newAttrs.url,
        label:        newAttrs.label,
        bgColor:      newAttrs.bgColor,
        textColor:    newAttrs.textColor,
        borderRadius: newAttrs.borderRadius,
        marginTop:    newAttrs.marginTop,
        marginBottom: newAttrs.marginBottom,
        borderWidth:  newAttrs.borderWidth,
        borderColor:  newAttrs.borderColor,
        iconName:     newAttrs.iconName,
      }),
    );
    setEditingButton(null);
  };

  const deleteEditButton = () => {
    if (!editor || editingButton === null) return;
    const { pos } = editingButton;
    const node = editor.state.doc.nodeAt(pos);
    if (node) editor.view.dispatch(editor.state.tr.delete(pos, pos + node.nodeSize));
    setEditingButton(null);
  };

  const confirmImage = ({ url, alt }: { url: string; alt: string }) => {
    if (!editor || !url) { setImageOpen(false); return; }
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

        {/* Font weight dropdown */}
        <select
          title="Font weight"
          value={currentFontWeight ?? ''}
          onChange={(e) => {
            if (!e.target.value) {
              editor.chain().focus().setMark('textStyle', { fontWeight: null }).run();
            } else {
              editor.chain().focus().setMark('textStyle', { fontWeight: e.target.value }).run();
            }
          }}
          style={{
            appearance: 'none',
            WebkitAppearance: 'none',
            height: 28,
            padding: '0 8px',
            background: currentFontWeight ? theme.color.accentBg : 'transparent',
            border: `1px solid ${currentFontWeight ? theme.color.accent : theme.color.border}`,
            borderRadius: 6,
            color: currentFontWeight ? theme.color.accent : theme.color.inkMuted,
            fontSize: 11,
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            flexShrink: 0,
          }}
        >
          <option value="">Wt</option>
          <option value="300">Light</option>
          <option value="500">Medium</option>
          <option value="600">Semibold</option>
          <option value="800">Extra Bold</option>
        </select>

        <ToolbarSep />

        <ToolbarButton
          title="Heading 1"
          active={editor.isActive('heading', { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          <span style={{ fontSize: 11, fontWeight: 700 }}>H1</span>
        </ToolbarButton>
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
          title="Heading 4"
          active={editor.isActive('heading', { level: 4 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 4 }).run()}
        >
          <span style={{ fontSize: 11, fontWeight: 700 }}>H4</span>
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
          title={editor.isActive('link') ? 'Edit link' : 'Insert link'}
          active={editor.isActive('link')}
          onClick={openLinkDialog}
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

      {linkOpen ? (
        <LinkDialog
          initial={linkInitial ?? undefined}
          onConfirm={confirmLink}
          onCancel={() => { setLinkOpen(false); setLinkInitial(null); }}
          onRemove={linkInitial ? removeLink : undefined}
        />
      ) : null}
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
