import { iconSvg } from './emailIcons.ts';

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
    blocks.push(`<p style="${STYLE_PARA}">${applyInlines(buffer.join('<br>'))}</p>`);
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
      const iconHtml = icon ? iconSvg(icon, tcC, 16) : '';
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
 *  prepend unconditionally. */
export function renderLogoHeader(brand?: BrandOptions): string {
  if (!brand) return '';
  const show = brand.logoShow !== false;
  const url = (brand.logoUrl ?? '').trim();
  if (!show || !url) return '';
  const maxWidth = Math.max(40, Math.min(320, brand.logoMaxWidth ?? 120));
  // The wrapper is a paragraph with the same 8px bottom margin as
  // every other block — keeps the rhythm consistent and means the
  // first body block sits exactly one paragraph break below the
  // logo regardless of what kind of block it is.
  return `<p style="margin:0 0 8px 0;text-align:center"><img src="${url}" alt="" style="max-width:${maxWidth}px;height:auto;display:inline-block;border:0"></p>`;
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
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1414;line-height:1.6;-webkit-font-smoothing:antialiased">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px">
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:14px;padding:32px 28px;font-size:15px;color:#0E1414">
      ${logo}${bodyHtml}
    </div>
    ${footer}
  </div>
</body></html>`;
}
