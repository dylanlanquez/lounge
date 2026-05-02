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
   * body. Tests pass `null` to inspect the body HTML alone. */
  shell?: 'lounge' | 'bare';
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
  const bodyHtml = parseFormatting(toBr(bodyAfterVars));
  const text = bodyToText(bodyAfterVars);
  const html =
    input.shell === 'bare'
      ? bodyHtml
      : wrapInLoungeShell(bodyHtml);
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
// Markdown-ish → HTML
// ─────────────────────────────────────────────────────────────────────────────

/** Convert raw newlines to <br> in groups of two-or-more (paragraph
 * breaks) vs single (line breaks). Mirrors Checkpoint behaviour. */
function toBr(text: string): string {
  if (!text) return '';
  return text.trim().replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}

/**
 * Apply the markdown-ish transformations to text that's already been
 * <br>-converted. Order matters — buttons must run before plain
 * links because the button regex's URL fragment would otherwise be
 * eaten by the link regex.
 */
export function parseFormatting(html: string): string {
  if (!html) return '';
  let out = html;

  // Horizontal rule
  out = out.replace(
    /---/g,
    '<hr style="border:none;border-top:1px solid #E5E2DC;margin:20px 0">',
  );

  // Headings — H2 / H3. Match the line up to a <br> or end of string.
  out = out.replace(
    /### (.+?)(<br>|$)/g,
    '<h3 style="font-size:16px;font-weight:600;margin:14px 0 6px;color:#0E1414;letter-spacing:-0.01em">$1</h3>',
  );
  out = out.replace(
    /## (.+?)(<br>|$)/g,
    '<h2 style="font-size:20px;font-weight:600;margin:18px 0 8px;color:#0E1414;letter-spacing:-0.01em">$1</h2>',
  );

  // Inline emphasis. Bold first so its inner text isn't eaten by
  // italic. The italic regex uses negative-lookbehind/lookahead on *
  // so ** doesn't trigger italic.
  out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');

  // Inline coloured text
  out = out.replace(
    /\{color:([^}]+)\}(.+?)\{\/color\}/g,
    '<span style="color:$1">$2</span>',
  );

  // Image
  out = out.replace(
    /!\[([^\]]*)\]\((.+?)\)/g,
    '<img src="$2" alt="$1" style="max-width:100%;border-radius:8px;margin:10px 0;display:block">',
  );

  // 6-param styled button: [button:label|bg|tc|rad|mt|mb](url)
  out = out.replace(
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
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      const mtC = mt || '12';
      const mbC = mb || '12';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:${mtC}px 0 ${mbC}px 0;letter-spacing:-0.005em">${label}</a>`;
    },
  );

  // Backward-compat 3-param button: [button:label|bg|tc|rad](url)
  out = out.replace(
    /\[button:(.+?)(?:\|([^|]*)\|([^|]*)\|([^\]]*))?\]\((.+?)\)/g,
    (
      _: string,
      label: string,
      bg: string | undefined,
      tc: string | undefined,
      rad: string | undefined,
      url: string,
    ) => {
      const bgC = bg || '#0E1414';
      const tcC = tc || '#FFFFFF';
      const radC = rad || '999';
      return `<a href="${url}" style="display:inline-block;padding:12px 28px;background:${bgC};color:${tcC};text-decoration:none;border-radius:${radC}px;font-weight:600;font-size:14px;margin:12px 0;letter-spacing:-0.005em">${label}</a>`;
    },
  );

  // Plain link — runs AFTER buttons so the button regex consumes its
  // own URL pattern first.
  out = out.replace(
    /\[(.+?)\]\((.+?)\)/g,
    '<a href="$2" style="color:#0E1414;text-decoration:underline">$1</a>',
  );

  // Bullet list. Matches `- item<br>` and renders as a styled list
  // row. Consecutive bullet lines render as multiple rows; the
  // renderer doesn't try to wrap them in a <ul> because email
  // clients (Outlook in particular) reset list styling
  // unpredictably. Each row stands on its own.
  out = out.replace(
    /^- (.+?)(<br>)/gm,
    '<span style="display:block;padding-left:16px;position:relative;margin:4px 0">' +
      '<span style="position:absolute;left:0;top:0;color:#0E1414">•</span>$1' +
      '</span>',
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
    .replace(/### (.+)/g, '$1')
    .replace(/## (.+)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '$1')
    .replace(/\{color:[^}]+\}([^{]+)\{\/color\}/g, '$1')
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

function wrapInLoungeShell(bodyHtml: string): string {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F7F6F2;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#0E1414;line-height:1.6;-webkit-font-smoothing:antialiased">
  <div style="max-width:600px;margin:0 auto;padding:32px 24px">
    <div style="background:#FFFFFF;border:1px solid #E5E2DC;border-radius:14px;padding:32px 28px;font-size:15px;color:#0E1414">
      ${bodyHtml}
    </div>
    <p style="margin:24px 0 0;color:#7B8285;font-size:12px;text-align:center;line-height:1.55">Venneir Limited</p>
  </div>
</body></html>`;
}
