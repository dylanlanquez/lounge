import { describe, expect, it } from 'vitest';
import {
  bodyToText,
  parseFormatting,
  renderEmail,
  substituteVariables,
} from './emailRenderer.ts';

// ─────────────────────────────────────────────────────────────────────────────
// substituteVariables
// ─────────────────────────────────────────────────────────────────────────────

describe('substituteVariables', () => {
  it('swaps a single variable', () => {
    expect(substituteVariables('Hi {{name}}', { name: 'Sarah' })).toBe('Hi Sarah');
  });

  it('swaps multiple variables', () => {
    expect(
      substituteVariables('Hi {{first}} {{last}}', { first: 'Sarah', last: 'Lane' }),
    ).toBe('Hi Sarah Lane');
  });

  it('leaves unknown variables in place so QA can spot them', () => {
    expect(substituteVariables('Hi {{name}} on {{day}}', { name: 'Sarah' })).toBe(
      'Hi Sarah on {{day}}',
    );
  });

  it('treats explicit empty string as a deliberate clear', () => {
    expect(substituteVariables('Hi {{name}}!', { name: '' })).toBe('Hi !');
  });

  it('handles repeats of the same variable', () => {
    expect(substituteVariables('{{x}} and {{x}}', { x: 'Y' })).toBe('Y and Y');
  });

  it('leaves non-variable {{...}} sequences alone if not matched', () => {
    expect(
      substituteVariables('Use {{var1}} or {{var-with-dash}}', { var1: 'A' }),
    ).toBe('Use A or {{var-with-dash}}');
  });

  it('returns empty string for falsy input', () => {
    expect(substituteVariables('', { x: 'y' })).toBe('');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseFormatting — every storage-syntax feature has a case
// ─────────────────────────────────────────────────────────────────────────────

describe('parseFormatting', () => {
  it('renders an H2', () => {
    const out = parseFormatting('## Hello<br>');
    expect(out).toContain('<h2');
    expect(out).toContain('Hello');
  });

  it('renders an H3', () => {
    const out = parseFormatting('### Sub<br>');
    expect(out).toContain('<h3');
    expect(out).toContain('Sub');
  });

  it('renders bold', () => {
    expect(parseFormatting('Hello **world**')).toContain('<strong>world</strong>');
  });

  it('renders italic without confusing it with bold', () => {
    const out = parseFormatting('A *one* and **two** here');
    expect(out).toContain('<em>one</em>');
    expect(out).toContain('<strong>two</strong>');
  });

  it('renders horizontal rule', () => {
    expect(parseFormatting('above<br>---<br>below')).toContain('<hr');
  });

  it('renders inline coloured text', () => {
    const out = parseFormatting('the {color:#ff0000}red{/color} car');
    expect(out).toContain('<span style="color:#ff0000">red</span>');
  });

  it('renders an image', () => {
    const out = parseFormatting('![logo](https://example.com/logo.png)');
    expect(out).toContain('<img src="https://example.com/logo.png"');
    expect(out).toContain('alt="logo"');
  });

  it('renders a plain link', () => {
    const out = parseFormatting('See [our terms](https://venneir.com/terms)');
    expect(out).toContain('<a href="https://venneir.com/terms"');
    expect(out).toContain('our terms</a>');
  });

  it('renders a styled button with all 6 args', () => {
    const out = parseFormatting(
      '[button:Reschedule|#0E1414|#FFFFFF|10|16|16](https://lounge.venneir.com/)',
    );
    expect(out).toContain('<a href="https://lounge.venneir.com/"');
    expect(out).toContain('background:#0E1414');
    expect(out).toContain('color:#FFFFFF');
    expect(out).toContain('border-radius:10px');
    expect(out).toContain('margin:16px 0 16px 0');
    expect(out).toContain('Reschedule</a>');
  });

  it('renders a styled button with default styling when args omitted', () => {
    const out = parseFormatting('[button:Click](https://example.com)');
    expect(out).toContain('background:#0E1414'); // default ink
    expect(out).toContain('border-radius:999px'); // default pill
  });

  it('renders a button before consuming its URL as a plain link', () => {
    const out = parseFormatting('[button:Go](https://example.com)');
    // The URL pattern (...) shouldn't bleed into a separate <a> tag.
    expect(out.match(/<a /g)?.length).toBe(1);
  });

  it('renders bullet list rows with bullet characters', () => {
    const out = parseFormatting('- one<br>- two<br>');
    expect(out).toContain('•');
    expect(out).toContain('one');
    expect(out).toContain('two');
  });

  it('returns empty string for empty input', () => {
    expect(parseFormatting('')).toBe('');
  });

  // ─── Symmetric block spacing ───────────────────────────────────────────
  // Each block element (heading, hr, image) renders with margin:0 so the
  // surrounding `<br><br>` controls the gap. Prevents the asymmetric
  // "headers feel weird" spacing where headings used to have their own
  // margins on top of the <br> rhythm.

  it('preserves the trailing <br> after a heading so gap below matches gap above', () => {
    // Storage `## Title\n\nBody` → `## Title<br><br>Body`. The H2
    // regex used to consume one <br>, leaving only one above the
    // body. Now both <br>s survive.
    const out = parseFormatting('## Title<br><br>Body');
    // Two <br>s after the heading close, before "Body".
    expect(out).toMatch(/<\/h2><br><br>Body/);
  });

  it('renders headings with margin:0 (let <br>s do the spacing)', () => {
    const out = parseFormatting('## Hello<br>');
    expect(out).toContain('margin:0');
    // No legacy 18px / 8px / 14px / 6px margins.
    expect(out).not.toMatch(/margin:1[48]px/);
  });

  it('renders HR with margin:0', () => {
    const out = parseFormatting('above<br>---<br>below');
    expect(out).toContain('margin:0');
    expect(out).not.toMatch(/margin:20px/);
  });

  it('renders images with margin:0', () => {
    const out = parseFormatting('![alt](https://x.png)');
    expect(out).toContain('<img');
    expect(out).toContain('margin:0');
    expect(out).not.toMatch(/margin:10px/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderEmail — the public path
// ─────────────────────────────────────────────────────────────────────────────

describe('renderEmail', () => {
  it('substitutes variables into both subject and body', () => {
    const out = renderEmail({
      subject: 'Hi {{name}}',
      bodySyntax: 'Hi {{name}}, your appointment is {{when}}',
      variables: { name: 'Sarah', when: 'Sat 9 May at 11:00' },
    });
    expect(out.subject).toBe('Hi Sarah');
    expect(out.html).toContain('Hi Sarah');
    expect(out.html).toContain('Sat 9 May at 11:00');
  });

  it('substitutes variables before formatting so {{var}} can sit inside a button label', () => {
    const out = renderEmail({
      subject: 'x',
      bodySyntax: '[button:See {{name}}](https://x)',
      variables: { name: 'Sarah' },
    });
    expect(out.html).toContain('See Sarah</a>');
  });

  it('wraps body in the Lounge HTML shell by default', () => {
    const out = renderEmail({
      subject: 'x',
      bodySyntax: 'hello',
      variables: {},
    });
    expect(out.html).toContain('<!DOCTYPE html>');
    expect(out.html).toContain('Venneir Limited');
  });

  it('renders bare body when shell="bare" — useful for in-app preview', () => {
    const out = renderEmail({
      subject: 'x',
      bodySyntax: 'hello',
      variables: {},
      shell: 'bare',
    });
    expect(out.html).not.toContain('<!DOCTYPE html>');
    expect(out.html).toContain('hello');
  });

  it('produces a plain-text version', () => {
    const out = renderEmail({
      subject: 'x',
      bodySyntax: '## Heading\n\n**Bold** then [link](https://x)',
      variables: {},
    });
    expect(out.text).toContain('Heading');
    expect(out.text).toContain('Bold');
    expect(out.text).toContain('link (https://x)');
    // No raw markup in the text version.
    expect(out.text).not.toContain('**');
    expect(out.text).not.toContain('## ');
  });

  it('round-trips a realistic template like the seeded reminder', () => {
    const out = renderEmail({
      subject: 'Reminder · {{serviceLabel}} tomorrow at {{appointmentTime}}',
      bodySyntax: `Hi {{patientFirstName}},

A friendly reminder that you have an appointment with us tomorrow.

## {{appointmentDateTime}}

**{{serviceLabel}}**
{{locationName}}

See you soon,
The Venneir Lounge team`,
      variables: {
        patientFirstName: 'Sarah',
        serviceLabel: 'Click-in veneers',
        appointmentTime: '11:00',
        appointmentDateTime: 'Sat 9 May at 11:00',
        locationName: 'Venneir Lounge',
      },
    });
    expect(out.subject).toBe('Reminder · Click-in veneers tomorrow at 11:00');
    expect(out.html).toContain('Hi Sarah,');
    expect(out.html).toContain('Sat 9 May at 11:00');
    expect(out.html).toContain('<strong>Click-in veneers</strong>');
    expect(out.html).toContain('Venneir Limited'); // shell footer
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bodyToText
// ─────────────────────────────────────────────────────────────────────────────

describe('bodyToText', () => {
  it('strips heading markers but keeps text', () => {
    expect(bodyToText('## Title\n\nbody')).toBe('Title\n\nbody');
  });

  it('strips bold + italic markers', () => {
    expect(bodyToText('**bold** and *italic*')).toBe('bold and italic');
  });

  it('represents links as "label (url)"', () => {
    expect(bodyToText('Click [here](https://x.com)')).toBe('Click here (https://x.com)');
  });

  it('represents buttons as "label: url"', () => {
    expect(bodyToText('[button:Reschedule](https://x.com)')).toBe(
      'Reschedule: https://x.com',
    );
  });
});
