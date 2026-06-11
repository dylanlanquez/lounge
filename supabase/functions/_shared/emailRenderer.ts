// _shared/emailRenderer.ts
//
// Deno port of src/lib/emailRenderer.ts. Single shared copy for
// every edge function that delivers a Lounge transactional email
// (lng-create-staff-account, lng-send-password-reset,
// lng-send-magic-link, ...). Three older send-* functions
// (send-appointment-reminders, send-appointment-confirmation,
// send-template-test) currently inline the parser; migrate them to
// this module in a follow-up so there's exactly one Deno parser to
// keep aligned with src/lib/emailRenderer.ts.
//
// If you change anything here you MUST also change
// src/lib/emailRenderer.ts and extend src/lib/emailRenderer.test.ts
// to cover the new behaviour. The browser preview and the outgoing
// email must render identically.
//
// ── Storage format (mirror of src/lib/emailRenderer.ts) ───────────
//
//   ## H2                 heading level 2
//   ### H3                heading level 3
//   #### H4               heading level 4
//   **bold**              bold
//   *italic*              italic
//   ---                   horizontal rule
//   - item                bullet list
//   {color:#hex}…{/color} inline coloured text
//   {w:NUM}…{/w}          inline weighted text
//   [label](url)          plain link
//   ![alt](url)           image
//   [button:label|bg|tc|radius|mt|mb](url)
//                         styled button (6 styling args)

import { iconImg as _iconImg, iconSvg as _iconSvg } from './emailIcons.ts';

export interface BrandSettings {
  logoUrl: string;
  /** Optional light-variant logo URL used by email clients that
   *  honour prefers-color-scheme: dark. Empty string means every
   *  client uses logoUrl. Mirrors BrandOptions.logoUrlDark on the
   *  browser-side renderer (keep these aligned). */
  logoUrlDark: string;
  logoShow: boolean;
  logoMaxWidth: number;
  accentColor: string;
  companyNumber: string;
  vatNumber: string;
  registeredAddress: string;
}

export const EMPTY_BRAND: BrandSettings = {
  logoUrl: '',
  logoUrlDark: '',
  logoShow: false,
  logoMaxWidth: 120,
  accentColor: '#0E1414',
  companyNumber: '',
  vatNumber: '',
  registeredAddress: '',
};

// Substitute {{var}} placeholders. Missing variables are left as-is
// (still showing {{var}}) so QA can spot them; loud-failure-friendly
// without crashing the send.
export function substituteVariables(template: string, variables: Record<string, string>): string {
  if (!template) return '';
  return template.replace(/\{\{(\w+)\}\}/g, (full, key: string) => {
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key] ?? '';
    }
    return full;
  });
}

const _BLOCK_MB = '0 0 8px 0';
const _STYLE_PARA = `margin:${_BLOCK_MB}`;
const _STYLE_H1 = `font-size:28px;font-weight:700;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.02em`;
const _STYLE_H2 = `font-size:20px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_H3 = `font-size:16px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:-0.01em`;
const _STYLE_H4 = `font-size:13px;font-weight:600;margin:${_BLOCK_MB};color:#0E1414;letter-spacing:0.02em;text-transform:uppercase`;
const _STYLE_HR = `border:none;border-top:1px solid #E5E2DC;margin:${_BLOCK_MB}`;
const _STYLE_IMG = `max-width:100%;border-radius:8px;margin:${_BLOCK_MB};display:block`;
const _STYLE_LIST = `margin:${_BLOCK_MB}`;
const _STYLE_LI = 'display:block;padding-left:16px;position:relative;margin:0';
const _STYLE_BUL = 'position:absolute;left:0;top:0;color:#0E1414';

function _applyInlines(text: string): string {
  let out = text;
  // Drop a button whose URL is empty (e.g. an optional CTA whose link
  // variable resolved to nothing, like a refund logged against no visit)
  // rather than leak literal "[button:Label]()" markup into the email.
  // Runs before the with-URL button rule, whose regex requires >=1 URL
  // char and so never matches the empty-parens form.
  out = out.replace(/\[button:[^\]]*\]\(\s*\)/g, '');
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  out = out.replace(/\{color:([^}]+)\}(.+?)\{\/color\}/g, '<span style="color:$1">$2</span>');
  out = out.replace(/\{w:([^}]+)\}(.+?)\{\/w\}/g, '<span style="font-weight:$1">$2</span>');
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
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      const mtC = mt || '12';
      const mbC = mb || '12';
      const bwNum = Number(bw || '0');
      const bcC = bc || '#0E1414';
      // Gmail strips inline <svg> from message bodies, so an
      // SVG-only icon renders fine in the admin preview but
      // disappears in actual inboxes. Try the PNG path first
      // (Gmail-safe) and fall back to inline SVG when the icon
      // hasn't been uploaded to lng-email-assets — that fallback
      // still works in clients that DO support inline SVG (Apple
      // Mail, modern Outlook web).
      const iconHtml = icon
        ? _iconImg(icon, tcC, 16) || _iconSvg(icon, tcC, 16)
        : '';
      const border = bwNum > 0 ? `border:${bwNum}px solid ${bcC};` : '';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:${mtC}px 0 ${mbC}px 0;letter-spacing:-0.005em;${border}">${iconHtml}${label}</a>`;
    },
  );
  out = out.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" style="color:#0E1414;text-decoration:underline">$1</a>');
  return out;
}

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
    const html = _applyInlines(buffer.join('<br>'));
    if (html.trim() !== '') blocks.push(`<p style="${_STYLE_PARA}">${html}</p>`);
    buffer = [];
  };
  const flushList = () => {
    if (listItems.length === 0) return;
    const items = listItems
      .map((item) => `<span style="${_STYLE_LI}"><span style="${_STYLE_BUL}">•</span>${_applyInlines(item)}</span>`)
      .join('');
    blocks.push(`<div style="${_STYLE_LIST}">${items}</div>`);
    listItems = [];
  };
  for (const line of lines) {
    if (line === '') {
      flushBuffer();
      // Do NOT flush the list here. Blank lines between bullet items are
      // cosmetic editor whitespace (staff routinely space out bullets
      // when editing a template) and must not break a list into separate
      // one-item lists with big gaps between them. The list is flushed
      // when a non-bullet line arrives (below) or at the very end.
      emptyStreak++;
      continue;
    }
    // A bullet that follows blank lines while a list is already open is a
    // continuation of that same list: absorb the blank gap (no &nbsp
    // spacers, no list break) so the bullets render tight.
    const continuingList = listItems.length > 0 && /^- (.+)$/.test(line);
    if (emptyStreak > 1 && !continuingList) {
      flushList();
      for (let i = 0; i < emptyStreak - 1; i++) blocks.push(`<p style="${_STYLE_PARA}">&nbsp;</p>`);
    }
    emptyStreak = 0;
    if (/^---+$/.test(line.trim())) {
      flushBuffer();
      flushList();
      blocks.push(`<hr style="${_STYLE_HR}">`);
      continue;
    }
    // Raw-HTML passthrough — lines that start with a recognised
    // block-level tag are emitted verbatim so a placeholder can ship
    // pre-rendered HTML (e.g. {{paymentStatusBlock}},
    // {{dentureRepairTable}}, {{appointmentTimeline}}). Without this
    // rule each placeholder gets wrapped in a <p> which the browser
    // auto-closes the moment it hits the inner <div> or <table>,
    // leaving stranded empty paragraphs that show up in Gmail as
    // extra vertical whitespace bracketing every block. Tag list is
    // a hand-picked allowlist so a paragraph that happens to start
    // with "<3" or an inline link doesn't accidentally trigger it.
    // Composers are responsible for shipping each block on ONE line
    // (no embedded \n) so this rule sees a single line as one block.
    // Mirrors src/lib/emailRenderer.ts line 221 — keep the two
    // parsers in lockstep so the admin preview matches reality.
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
      blocks.push(`<h4 style="${_STYLE_H4}">${_applyInlines(h4[1])}</h4>`);
      continue;
    }
    const h3 = line.match(/^### (.+)$/);
    if (h3 && h3[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h3 style="${_STYLE_H3}">${_applyInlines(h3[1])}</h3>`);
      continue;
    }
    const h2 = line.match(/^## (.+)$/);
    if (h2 && h2[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h2 style="${_STYLE_H2}">${_applyInlines(h2[1])}</h2>`);
      continue;
    }
    const h1 = line.match(/^# (.+)$/);
    if (h1 && h1[1]) {
      flushBuffer();
      flushList();
      blocks.push(`<h1 style="${_STYLE_H1}">${_applyInlines(h1[1])}</h1>`);
      continue;
    }
    const img = line.trim().match(/^!\[([^\]]*)\]\((.+?)\)$/);
    if (img && img[2] !== undefined) {
      flushBuffer();
      flushList();
      blocks.push(`<img src="${img[2]}" alt="${img[1] ?? ''}" style="${_STYLE_IMG}">`);
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
    .replace(/\[button:([^|\]]+)(?:\|[^\]]*)?\]\((.+?)\)/g, '$1: $2')
    .replace(/\[(.+?)\]\((.+?)\)/g, '$1 ($2)')
    .replace(/^---$/gm, '────────────')
    .trim();
}

function renderLogoHeader(brand: BrandSettings): string {
  if (!brand.logoShow || !brand.logoUrl) return '';
  const maxWidth = Math.max(40, Math.min(320, brand.logoMaxWidth));
  const urlDark = (brand.logoUrlDark ?? '').trim();
  const imgStyle = `max-width:${maxWidth}px;height:auto;display:inline-block;border:0`;
  // Left-aligned to match the rest of the in-app surfaces.
  // <picture> is used when a dark-variant logo URL is configured;
  // clients that honour prefers-color-scheme (Apple Mail, Outlook
  // for Mac/iOS, Gmail iOS) swap in the light variant for users in
  // dark mode. Everywhere else falls through to the default <img>.
  const inner = urlDark
    ? `<picture><source srcset="${urlDark}" media="(prefers-color-scheme: dark)"><img src="${brand.logoUrl}" alt="" style="${imgStyle}"></picture>`
    : `<img src="${brand.logoUrl}" alt="" style="${imgStyle}">`;
  return `<p style="margin:0 0 8px 0;text-align:left">${inner}</p>`;
}

function renderLegalFooter(brand: BrandSettings): string {
  const lines: string[] = ['Venneir Limited'];
  if (brand.companyNumber) lines.push(`Company no. ${brand.companyNumber}`);
  if (brand.vatNumber) lines.push(`VAT no. ${brand.vatNumber}`);
  if (brand.registeredAddress) lines.push(brand.registeredAddress);
  return `<p style="margin:24px 0 0;color:#7B8285;font-size:12px;text-align:center;line-height:1.55">${lines.join(' · ')}</p>`;
}

export function wrapInLoungeShell(bodyHtml: string, brand: BrandSettings): string {
  const logo = renderLogoHeader(brand);
  const footer = renderLegalFooter(brand);
  // Force the email to render light-mode in every client that
  // respects the directive — see the matching browser-side shell
  // in src/lib/emailRenderer.ts for the long-form explanation of
  // why all three layers (meta, style, body attr) are required.
  // Keep the two shells byte-identical so a Resend send through the
  // edge function looks the same as the admin preview.
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

// ─────────────────────────────────────────────────────────────────────────────
// Loaders against the project DB. Both safe-fail to empty values
// rather than throwing, so a transient DB hiccup degrades email
// branding (no logo) instead of swallowing the send entirely.
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateRow {
  subject: string;
  body_syntax: string;
  enabled: boolean;
}

// Untyped client to avoid the supabase-js type circular import.
// Callers pass their already-built service-role client.
type AdminClient = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> };
      or: (filter: string) => { is: (col: string, val: null) => Promise<{ data: unknown; error: unknown }> };
    };
  };
};

export async function loadTemplate(
  admin: AdminClient,
  key: string,
): Promise<TemplateRow | null> {
  const { data, error } = await admin
    .from('lng_email_templates')
    .select('subject, body_syntax, enabled')
    .eq('key', key)
    .maybeSingle();
  if (error || !data) return null;
  return data as TemplateRow;
}

export async function loadBrand(admin: AdminClient): Promise<BrandSettings> {
  const { data: rows, error } = await admin
    .from('lng_settings')
    .select('key, value')
    .or('key.like.email.%,key.like.legal.%')
    .is('location_id', null);
  if (error || !rows) return EMPTY_BRAND;
  const map = new Map<string, unknown>();
  for (const r of rows as Array<{ key: string; value: unknown }>) map.set(r.key, r.value);
  const get = <T>(k: string, fallback: T): T => {
    const v = map.get(k);
    return v === undefined || v === null ? fallback : (v as T);
  };
  return {
    logoUrl: get<string>('email.brand_logo_url', ''),
    logoUrlDark: get<string>('email.brand_logo_url_dark', ''),
    logoShow: get<boolean>('email.brand_logo_show', true),
    logoMaxWidth: get<number>('email.brand_logo_max_width', 120),
    accentColor: get<string>('email.brand_accent_color', '#0E1414'),
    companyNumber: get<string>('legal.company_number', ''),
    vatNumber: get<string>('legal.vat_number', ''),
    registeredAddress: get<string>('legal.registered_address', ''),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resend send. Common shape across every Lounge transactional email
// — From / Reply-To come from the caller because the env-var names
// differ per use case (RESEND_FROM_BOOKING vs LNG_INVITE_FROM, etc).
// ─────────────────────────────────────────────────────────────────────────────

export async function sendViaResend(args: {
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }> {
  if (!args.apiKey) return { ok: false, error: 'RESEND_API_KEY not configured' };
  let r: Response;
  try {
    r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: args.from,
        to: [args.to],
        reply_to: args.replyTo,
        subject: args.subject,
        html: args.html,
        text: args.text,
      }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Resend network error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const respBody = await r.json().catch(() => ({}));
  if (!r.ok) return { ok: false, error: `Resend ${r.status}: ${JSON.stringify(respBody)}` };
  return { ok: true, messageId: (respBody as { id?: string }).id };
}

// ─────────────────────────────────────────────────────────────────────────────
// Convenience: render + send in one call. Most chunk-2 functions just
// want subject + body templated, branded shell, and Resend delivered.
// ─────────────────────────────────────────────────────────────────────────────

export interface RenderAndSendArgs {
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  template: TemplateRow;
  brand: BrandSettings;
  variables: Record<string, string>;
}

export async function renderAndSend(args: RenderAndSendArgs): Promise<
  | { ok: true; messageId?: string; subject: string; html: string; text: string }
  | { ok: false; error: string }
> {
  const subject = substituteVariables(args.template.subject, args.variables);
  const bodyAfterVars = substituteVariables(args.template.body_syntax, args.variables);
  const html = wrapInLoungeShell(parseFormatting(bodyAfterVars), args.brand);
  const text = bodyToText(bodyAfterVars);
  const send = await sendViaResend({
    apiKey: args.apiKey,
    from: args.from,
    replyTo: args.replyTo,
    to: args.to,
    subject,
    html,
    text,
  });
  if (!send.ok) return send;
  // Return html + text so the caller can persist the rendered bytes
  // on lng_email_messages. Without that, the Timeline "View email"
  // button has nothing to render — the patient saw the email but
  // staff sees a blank preview.
  return { ok: true, messageId: send.messageId, subject, html, text };
}
