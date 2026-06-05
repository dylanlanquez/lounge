import { iconImg, iconSvg } from './emailIcons.ts';

// ─────────────────────────────────────────────────────────────────────────────
// Email body renderer.
//
// Single source of truth for taking a `body_syntax` string from
// lng_email_templates and turning it into Resend-ready HTML. Used by:
//
//   • src/components/SnippetEditor — round-trips between TipTap's
//     HTML format and the storage syntax via syntaxToHtml /
//     htmlToSyntax (parallel to Checkpoint's editor).
//   • src/components/EmailTemplatePreview — renders the live preview
//     inside the admin UI using the same parseFormatting pipeline.
//   • supabase/functions/send-appointment-reminders — renders the
//     real outgoing email at send time.
//
// The renderer is pure, deterministic, and importable from both
// browser and Deno contexts (no DOM, no node-only APIs). It mirrors
// Checkpoint's _shared/emailRenderer.ts behaviour verbatim where
// the format is shared, with Lounge-specific theming for the HTML
// shell.
//
// ── Storage format ────────────────────────────────────────────────
//
//   ## H2                 heading level 2
//   ### H3                heading level 3
//   **bold**              bold
//   *italic*              italic (single-asterisk avoiding **)
//   ---                   horizontal rule
//   - item                bullet list (one per line; consecutive
//                         lines join into one <ul>)
//   {color:#hex}…{/color} inline coloured text
//   [label](url)          plain link
//   ![alt](url)           image
//   [button:label|bg|tc|radius|mt|mb](url)
//                         styled button (6 styling args, all
//                         optional with sensible defaults)
//
// All other text becomes paragraphs joined by <br>. Variable
// substitution ({{var}}) happens BEFORE parseFormatting so the
// substituted values become part of the formatted output (i.e. an
// admin can put a variable inside a button label and it works).

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

export interface BrandOptions {
  /** Logo URL shown at the top of the white card. Empty string or
   *  show=false to omit the header. */
  logoUrl?: string;
  /** Optional light-variant logo URL used in email clients that
   *  honour `prefers-color-scheme: dark` and force the email's white
   *  card to a dark background. When set, the renderer wraps the
   *  img in <picture> with a dark-mode <source>; when empty, every
   *  client falls back to `logoUrl`. */
  logoUrlDark?: string;
  /** Whether to render the logo header at all. */
  logoShow?: boolean;
  /** Logo max-width in pixels. Defaults to 120. */
  logoMaxWidth?: number;
  /** Hex including leading `#`. Empty falls back to ink. */
  accentColor?: string;
  /** Legal footer fields. Any non-empty value appears in the footer. */
  companyNumber?: string;
  vatNumber?: string;
  registeredAddress?: string;
}

export interface RenderEmailInput {
  /** The template's subject line, with {{var}} placeholders. */
  subject: string;
  /** The template's body in storage syntax, with {{var}} placeholders. */
  bodySyntax: string;
  /** Variable values to substitute. Missing keys leave the
   * placeholder in place rather than blanking it — easier to spot a
   * misnamed variable in QA than a silently empty email. */
  variables: Record<string, string>;
  /** Optional override of the default branding wrapped around the
   * body. Tests pass `'bare'` to inspect the body HTML alone. */
  shell?: 'lounge' | 'bare';
  /** Branding options pulled from lng_settings (`email.brand_*`,
   *  `legal.*`). Optional — when omitted the shell renders without
   *  a logo header or legal footer. The admin tab populates this. */
  brand?: BrandOptions;
}

export interface RenderedEmail {
  subject: string;
  /** Full HTML email ready to hand to Resend. */
  html: string;
  /** Plain-text fallback derived from the body. */
  text: string;
}

export function renderEmail(input: RenderEmailInput): RenderedEmail {
  const subject = substituteVariables(input.subject, input.variables);
  const bodyAfterVars = substituteVariables(input.bodySyntax, input.variables);
  const bodyHtml = parseFormatting(bodyAfterVars);
  const text = bodyToText(bodyAfterVars);
  const html =
    input.shell === 'bare'
      ? renderLogoHeader(input.brand) + bodyHtml
      : wrapInLoungeShell(bodyHtml, input.brand);
  return { subject, html, text };
}

/**
 * Substitute {{var}} placeholders in a string. Missing variables
 * are left as-is (still showing {{var}}) so QA can spot them; it's
 * loud-failure-friendly without being so loud it crashes the send.
 */
export function substituteVariables(
  template: string,
  variables: Record<string, string>,
): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key] ?? '';
    }
    return full;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage syntax → HTML
// ─────────────────────────────────────────────────────────────────────────────
//
// Paragraph-based renderer. Every block (paragraph, heading, hr,
// list, image) is wrapped in its own element with the same fixed
// bottom margin (BLOCK_MARGIN_BOTTOM). That gives one predictable
// gap between every two blocks — same rhythm whether the user goes
// paragraph→paragraph, heading→paragraph, paragraph→hr, anywhere.
// Universally supported across Apple Mail, Gmail and Outlook because
// the only spacing primitive is `margin-bottom` on a `<p>` / `<h2>`
// / etc., not `<br><br>` stacks.
//
// Newline semantics in storage syntax:
//
//   \n          soft line break inside the same paragraph (<br>)
//   \n\n        paragraph break (one BLOCK_MARGIN_BOTTOM gap)
//   \n\n\n      paragraph break + 1 empty paragraph (an extra blank
//               line of visual spacing for the user)
//   \n\n\n\n    paragraph break + 2 empty paragraphs
//   …           each additional \n adds one more empty <p> spacer

const BLOCK_MARGIN_BOTTOM = '0 0 8px 0';
const STYLE_PARA = `margin:${BLOCK_MARGIN_BOTTOM}`;
const STYLE_H1 = `font-size:28px;font-weight:700;margin:${BLOCK_MARGIN_BOTTOM};color:#0E1414;letter-spacing:-0.02em`;
const STYLE_H2 = `font-size:20px;font-weight:600;margin:${BLOCK_MARGIN_BOTTOM};color:#0E1414;letter-spacing:-0.01em`;
const STYLE_H3 = `font-size:16px;font-weight:600;margin:${BLOCK_MARGIN_BOTTOM};color:#0E1414;letter-spacing:-0.01em`;
const STYLE_H4 = `font-size:13px;font-weight:600;margin:${BLOCK_MARGIN_BOTTOM};color:#0E1414;letter-spacing:0.02em;text-transform:uppercase`;
const STYLE_HR = `border:none;border-top:1px solid #E5E2DC;margin:${BLOCK_MARGIN_BOTTOM}`;
const STYLE_IMG = `max-width:100%;border-radius:8px;margin:${BLOCK_MARGIN_BOTTOM};display:block`;
const STYLE_LIST = `margin:${BLOCK_MARGIN_BOTTOM}`;
const STYLE_LIST_ITEM = 'display:block;padding-left:16px;position:relative;margin:0';
const STYLE_BULLET = 'position:absolute;left:0;top:0;color:#0E1414';

export function parseFormatting(syntax: string): string {
  if (!syntax) return '';
  const trimmed = syntax.replace(/^\n+|\n+$/g, '');
  if (!trimmed) return '';

  const lines = trimmed.split('\n');
  const blocks: string[] = [];
  let buffer: string[] = [];
  let listItems: string[] = [];
  let emptyStreak = 0;

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    // A paragraph that renders to nothing after inline processing (e.g. a
    // lone dropped empty-URL button) must not leave a ghost <p> behind.
    const html = applyInlines(buffer.join('<br>'));
    if (html.trim() !== '') blocks.push(`<p style="${STYLE_PARA}">${html}</p>`);
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    // Manual <span>-based bullets — Outlook desktop strips
    // <ul>/<li> styling unpredictably, but inline-styled spans
    // render identically across every client.
    const items = listItems
      .map(
        (item) =>
          `<span style="${STYLE_LIST_ITEM}"><span style="${STYLE_BULLET}">•</span>${applyInlines(item)}</span>`,
      )
      .join('');
    blocks.push(`<div style="${STYLE_LIST}">${items}</div>`);
    listItems = [];
  };

  for (const line of lines) {
    if (line === '') {
      flushBuffer();
      flushList();
      emptyStreak++;
      continue;
    }
    // Each empty line *beyond the first* in a streak becomes one
    // empty paragraph spacer — that's how the user buys extra
    // vertical space by pressing Enter more than once.
    if (emptyStreak > 1) {
      for (let i = 0; i < emptyStreak - 1; i++) {
        blocks.push(`<p style="${STYLE_PARA}">&nbsp;</p>`);
      }
    }
    emptyStreak = 0;

    if (/^---+$/.test(line.trim())) {
      flushBuffer();
      flushList();
      blocks.push(`<hr style="${STYLE_HR}">`);
      continue;
    }
    // Raw-HTML passthrough — lines that start with a recognised
    // block-level tag are emitted verbatim so a placeholder can ship
    // pre-rendered HTML (e.g. the {{dentureRepairTable}} variable).
    // Restricted to a hand-picked tag list so a paragraph that
    // happens to start with "<3" or an inline link doesn't trigger
    // it. The placeholder is responsible for keeping the whole HTML
    // on ONE line so this rule sees a single block.
    if (/^\s*<(table|div|section|article|aside|figure)[\s>]/i.test(line)) {
      flushBuffer();
      flushList();
      blocks.push(line);
      continue;
    }
    const h4 = line.match(/^#### (.+)$/);
    if (h4 && h4[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h4 style="${STYLE_H4}">${applyInlines(h4[1])}</h4>`);
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3 && h3[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h3 style="${STYLE_H3}">${applyInlines(h3[1])}</h3>`);
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2 && h2[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h2 style="${STYLE_H2}">${applyInlines(h2[1])}</h2>`);
      continue;
    }
    const h1 = line.match(/^# (.+)$/);
    if (h1 && h1[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h1 style="${STYLE_H1}">${applyInlines(h1[1])}</h1>`);
      continue;
    }
    const img = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
    if (img && img[2] !== undefined) {
      flushBuffer();
      flushList();
      blocks.push(
        `<img src="${img[2]}" alt="${img[1] ?? ''}" style="${STYLE_IMG}">`,
      );
      continue;
    }
    const li = line.match(/^- (.+)$/);
    if (li && li[1]) {
      flushBuffer();
      listItems.push(li[1]);
      continue;
    }
    flushList();
    buffer.push(line);
  }
  flushBuffer();
  flushList();

  return blocks.join('');
}

/** Apply inline-only transforms (bold, italic, color, font-weight,
 *  link, button) to a single line / paragraph's content. Buttons run
 *  before plain links so the button regex consumes its own URL pattern
 *  first. */
function applyInlines(text: string): string {
  let out = text;
  // Drop a button whose URL is empty (e.g. an optional CTA whose link
  // variable resolved to nothing) rather than leak literal
  // "[button:Label]()" markup. The with-URL button rule below requires
  // >=1 URL char and so never matches the empty-parens form.
  out = out.replace(/\[button:[^\]]*\]\(\s*\)/g, '');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(
    /\{color:([^}]+)\}(.+?)\{\/color\}/g,
    '<span style="color:$1">$2</span>',
  );
  out = out.replace(
    /\{w:([^}]+)\}(.+?)\{\/w\}/g,
    '<span style="font-weight:$1">$2</span>',
  );
  // 9-param button: [button:label|bg|tc|rad|mt|mb|bw|bc|icon](url)
  // Params 7-9 (bw/bc/icon) are an optional sub-group; params 2-6
  // are also optional. Falls back to sensible defaults for each.
  // Character class [^|<>\]"(]* excludes HTML-structural characters so
  // the groups cannot match across <br> tags when buttons are adjacent.
  out = out.replace(
    /\[button:(.+?)(?:\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*)(?:\|([^|<>\]"(]*)\|([^|<>\]"(]*)\|([^|<>\]"(]*))?)?\]\(([^)]+)\)/g,
    (
      _: string,
      label: string,
      bg: string | undefined,
      tc: string | undefined,
      rad: string | undefined,
      mt: string | undefined,
      mb: string | undefined,
      bw: string | undefined,
      bc: string | undefined,
      icon: string | undefined,
      url: string,
    ) => {
      const bgC     = bg   || '#0E1414';
      const tcC     = tc   || '#FFFFFF';
      const radC    = rad  || '999';
      const mtC     = mt   || '12';
      const mbC     = mb   || '12';
      const bwNum   = Number(bw || '0');
      const bcC     = bc   || '#0E1414';
      // Match the edge function renderer: prefer the hosted PNG (Gmail
      // strips inline <svg>), fall back to SVG when no PNG is uploaded
      // for this icon. Keeps the admin preview honest to what Gmail
      // will actually show.
      const iconHtml = icon
        ? iconImg(icon, tcC, 16) || iconSvg(icon, tcC, 16)
        : '';
      const border  = bwNum > 0 ? `border:${bwNum}px solid ${bcC};` : '';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:${mtC}px 0 ${mbC}px 0;letter-spacing:-0.005em;${border}">${iconHtml}${label}</a>`;
    },
  );
  out = out.replace(
    /\[(.+?)\]\((.+?)\)/g,
    '<a href="$2" style="color:#0E1414;text-decoration:underline">$1</a>',
  );
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plain-text fallback
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort plain-text version of the body. Strips formatting
 * markers and converts buttons to "label (url)" so the text version
 * stays readable. Resend uses this for clients that render
 * text/plain only.
 */
export function bodyToText(syntax: string): string {
  if (!syntax) return '';
  return syntax
    .replace(/#### (.+)/g, '$1')
    .replace(/### (.+)/g, '$1')
    .replace(/## (.+)/g, '$1')
    .replace(/# (.+)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/\{color:[^}]+\}([^{]+)\{\/color\}/g, '$1')
    .replace(/\{w:[^}]+\}([^{]+)\{\/w\}/g, '$1')
    .replace(/!\[([^\]]*)\]\((.+?)\)/g, '[image: $1 — $2]')
    .replace(/\[button:[^\]]*\]\(\s*\)/g, '')
    .replace(
      /\[button:([^|\]]+)(?:\|[^\]]*)?\]\((.+?)\)/g,
      '$1: $2',
    )
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^---$/gm, '────────────')
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML shell
// ─────────────────────────────────────────────────────────────────────────────
//
// Branded wrapper around the rendered body. Inline-styled (no
// stylesheets — email client compatibility), max-width 600px (mobile-
// safe), Venneir-branded background and footer. Mirrors the visual
// language of send-appointment-confirmation's hardcoded HTML so
// reminders look like a sibling email, not a foreign one.

/** Logo header rendered inside the white card before the body. The
 *  email shell calls this; the bare/preview shell calls it inline.
 *  Returns empty string when the brand says no logo, so callers can
 *  prepend unconditionally.
 *
 *  Left-aligned (margin:0, text-align:left) so the header reads
 *  consistently with how Lounge frames every other top-of-card
 *  surface in the app.
 *
 *  Dark-mode: when `logoUrlDark` is set, the img is wrapped in
 *  <picture> with a `(prefers-color-scheme: dark)` <source>. Email
 *  clients that respect the media query (Apple Mail, Outlook for
 *  Mac/iOS, Gmail iOS) swap in the light variant when the user is
 *  in dark mode; everywhere else falls back to the default <img>.
 *  Inline width/height kept on the trailing <img> because <picture>
 *  itself doesn't accept those attributes — the <img> is what
 *  actually renders. */
export function renderLogoHeader(brand?: BrandOptions): string {
  if (!brand) return '';
  const show = brand.logoShow !== false;
  const url = (brand.logoUrl ?? '').trim();
  if (!show || !url) return '';
  const maxWidth = Math.max(40, Math.min(320, brand.logoMaxWidth ?? 120));
  const urlDark = (brand.logoUrlDark ?? '').trim();
  const imgStyle = `max-width:${maxWidth}px;height:auto;display:inline-block;border:0`;
  const inner = urlDark
    ? `<picture><source srcset="${urlDark}" media="(prefers-color-scheme: dark)"><img src="${url}" alt="" style="${imgStyle}"></picture>`
    : `<img src="${url}" alt="" style="${imgStyle}">`;
  return `<p style="margin:0 0 8px 0;text-align:left">${inner}</p>`;
}

/** Legal footer block. Renders below the white card (outside it) with
 *  Venneir Limited + any company number / VAT / registered address
 *  the admin has set. UK statute requires the company number and
 *  registered address on customer-facing comms for limited
 *  companies. */
export function renderLegalFooter(brand?: BrandOptions): string {
  const lines: string[] = ['Venneir Limited'];
  const companyNumber = (brand?.companyNumber ?? '').trim();
  const vatNumber = (brand?.vatNumber ?? '').trim();
  const registeredAddress = (brand?.registeredAddress ?? '').trim();
  if (companyNumber) lines.push(`Company no. ${companyNumber}`);
  if (vatNumber) lines.push(`VAT no. ${vatNumber}`);
  if (registeredAddress) lines.push(registeredAddress);
  return `<p style="margin:24px 0 0;color:#7B8285;font-size:12px;text-align:center;line-height:1.55">${lines.join(' · ')}</p>`;
}

function wrapInLoungeShell(bodyHtml: string, brand?: BrandOptions): string {
  const logo = renderLogoHeader(brand);
  const footer = renderLegalFooter(brand);
  // Force the email to render in light mode in every client that
  // respects the directive. The meta + style + body attribute trio
  // covers the three layers different clients honour:
  //   * <meta name="color-scheme" content="light only">   — Apple Mail,
  //     Outlook for Mac/iOS, AOL, Yahoo. Tells the client we're not
  //     a dark-aware design.
  //   * <meta name="supported-color-schemes" ...>        — the
  //     older Apple Mail equivalent. Cheap to ship both.
  //   * CSS `color-scheme: light` on :root + body        — required
  //     by Outlook iOS for the meta to take effect, harmless on the
  //     others.
  // Gmail web / Gmail Android still apply their own "force dark"
  // algorithm regardless, which is what the dark-variant logo URL
  // (via renderLogoHeader's <picture>) and the off-white card
  // background mitigate. No fix is 100% — these three layers cover
  // the bulk of users where it matters.
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width">
  <meta name="color-scheme" content="light only">
  <meta name="supported-color-schemes" content="light only">
  <style>
    :root { color-scheme: light only; supported-color-schemes: light only; }
    body  { color-scheme: light only; supported-color-schemes: light only; }
  </style>
</head>
<body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1414;line-height:1.6;-webkit-font-smoothing:antialiased;color-scheme:light only">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px">
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:14px;padding:32px 28px;font-size:15px;color:#0E1414">
      ${logo}${bodyHtml}
    </div>
    ${footer}
  </div>
</body></html>`;
}
