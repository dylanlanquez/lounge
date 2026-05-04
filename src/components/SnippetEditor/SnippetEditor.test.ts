/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { htmlToSyntax, syntaxToHtml } from './SnippetEditor.tsx';

// Round-trip regression suite for the email template editor's
// HTML ↔ storage syntax pair. Every case here was a real corruption
// before the block-separator fix:
//
//   • H2/H3/HR/IMG output had no trailing newline, so a heading
//     followed by anything would glue them together — paragraph
//     text getting eaten by the heading, or the literal `## Two`
//     showing up inside the previous heading's text.
//   • Empty <p>'s were squashed by a `\n{3,}` → `\n\n` collapse,
//     so any blank line the user added for vertical spacing was
//     destroyed on save and never came back on reload.

describe('SnippetEditor round-trip', () => {
  // Helper: HTML → syntax → HTML must equal the original, and a
  // second round-trip must be a no-op (idempotent).
  const expectStable = (html: string) => {
    const stored = htmlToSyntax(html);
    const reloaded = syntaxToHtml(stored);
    const restored = htmlToSyntax(reloaded);
    expect(reloaded).toBe(html);
    expect(restored).toBe(stored);
  };

  it('preserves an empty paragraph used as visual spacing', () => {
    expectStable('<p>foo</p><p></p><p>bar</p>');
  });

  it('preserves multiple consecutive empty paragraphs', () => {
    expectStable('<p>foo</p><p></p><p></p><p>bar</p>');
  });

  it('keeps an H2 separate from the paragraph that follows it', () => {
    expectStable('<h2>Title</h2><p>Body</p>');
  });

  it('keeps an H2 separate from a following H2 (no `## Two` leak)', () => {
    expectStable('<h2>One</h2><h2>Two</h2>');
  });

  it('keeps an H2 separate from a following H3 and paragraph', () => {
    expectStable('<h2>Title</h2><h3>Sub</h3><p>Body</p>');
  });

  it('keeps an HR between paragraphs (no literal `---` leak)', () => {
    expectStable('<p>before</p><hr><p>after</p>');
  });

  it('keeps an image between paragraphs (no silent loss)', () => {
    expectStable('<p>before</p><img src="a.png" alt="x"><p>after</p>');
  });

  it('preserves a soft line break inside a paragraph', () => {
    expectStable('<p>line one<br>line two</p>');
  });

  it('round-trips the seeded booking-confirmation pattern', () => {
    // Mirrors the shape of the seeded body: H2 with a date/time,
    // a paragraph with bold service label + soft break to location,
    // then a follow-up paragraph. Used to corrupt every save.
    expectStable(
      '<h2>{{appointmentDateTime}}</h2>' +
        '<p><strong>{{serviceLabel}}</strong><br>{{locationName}}</p>' +
        '<p>If something has changed, reply to this email.</p>',
    );
  });

  it('preserves a styled button between paragraphs', () => {
    expectStable(
      '<p>Click below.</p>' +
        '<p><span data-type="styled-button" data-url="https://example.com" ' +
        'data-bg="#0E1414" data-text-color="#FFFFFF" data-radius="999" ' +
        'data-mt="12" data-mb="12" ' +
        'style="display:inline-block;padding:8px 20px;background:#0E1414;color:#FFFFFF;' +
        'border-radius:999px;font-weight:600;font-size:13px;cursor:default;' +
        'text-decoration:none;margin:12px 0 12px 0">Click here</span></p>',
    );
  });
});

describe('SnippetEditor storage syntax', () => {
  it('saves a heading + paragraph with a single block separator', () => {
    expect(htmlToSyntax('<h2>Title</h2><p>Body</p>')).toBe('## Title\n\nBody');
  });

  it('saves an empty paragraph as a single extra newline beyond the separator', () => {
    // foo\n\n  paragraph break
    //    \n   one empty paragraph
    // bar     content
    expect(htmlToSyntax('<p>foo</p><p></p><p>bar</p>')).toBe('foo\n\n\nbar');
  });

  it('does not collapse multi-newline runs (was the empty-p bug)', () => {
    expect(htmlToSyntax('<p>foo</p><p></p><p></p><p>bar</p>')).toBe('foo\n\n\n\nbar');
  });
});
