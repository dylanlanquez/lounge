import { describe, expect, it } from 'vitest';
import { extractPhoneFromIntake, isPlaceholderEmail } from './identity.ts';

describe('isPlaceholderEmail', () => {
  it('treats null/undefined/empty as placeholder', () => {
    expect(isPlaceholderEmail(null)).toBe(true);
    expect(isPlaceholderEmail(undefined)).toBe(true);
    expect(isPlaceholderEmail('')).toBe(true);
    expect(isPlaceholderEmail('   ')).toBe(true);
  });

  it('treats malformed email (no @) as placeholder', () => {
    expect(isPlaceholderEmail('not-an-email')).toBe(true);
    expect(isPlaceholderEmail('foo')).toBe(true);
  });

  it.each([
    'noemail@gmail.com',
    'NoEmail@Gmail.com',
    'no-email@gmail.com',
    'no_email@gmail.com',
    'no.email@gmail.com',
    'none@gmail.com',
    'noaddress@anywhere.co.uk',
    'noreply@something.io',
    'no-reply@x.com',
    'donotreply@somewhere.org',
    'do-not-reply@x.com',
    'unknown@gmail.com',
    'n/a@x.com',
    'na@x.com',
  ])('flags placeholder local part: %s', (email) => {
    expect(isPlaceholderEmail(email)).toBe(true);
  });

  it.each([
    'sandra.denyer@hotmail.co.uk',
    'irene@robinson.co.uk',
    'IRENE@ROBINSON.CO.UK',
    'patient+tag@gmail.com',
    'first.last@nhs.net',
  ])('passes through real-looking emails: %s', (email) => {
    expect(isPlaceholderEmail(email)).toBe(false);
  });

  it('flags placeholder domains regardless of local', () => {
    expect(isPlaceholderEmail('john.doe@example.com')).toBe(true);
    expect(isPlaceholderEmail('foo@noemail.com')).toBe(true);
    expect(isPlaceholderEmail('foo@invalid.com')).toBe(true);
  });

  it('does not flag legitimate emails that contain "no" prefix', () => {
    expect(isPlaceholderEmail('norman@gmail.com')).toBe(false);
    expect(isPlaceholderEmail('nora@nhs.net')).toBe(false);
    expect(isPlaceholderEmail('noah@gmail.com')).toBe(false);
  });
});

describe('extractPhoneFromIntake', () => {
  it('returns null for null/empty/undefined', () => {
    expect(extractPhoneFromIntake(null)).toBeNull();
    expect(extractPhoneFromIntake(undefined)).toBeNull();
    expect(extractPhoneFromIntake([])).toBeNull();
  });

  it('extracts the answer for a "Contact Number" question (the Calendly default)', () => {
    expect(
      extractPhoneFromIntake([
        { question: 'Repair Type', answer: 'Snapped Denture' },
        { question: 'Contact Number', answer: '+44 7874 037109' },
      ])
    ).toBe('+44 7874 037109');
  });

  it.each([
    'Phone',
    'Phone number',
    'Mobile',
    'Mobile number',
    'Tel',
    'Telephone',
    'Telephone number',
    'Contact Number',
    'Contact #',
    'Cell',
  ])('matches "%s" as a phone-question label', (label) => {
    expect(extractPhoneFromIntake([{ question: label, answer: '+44 1234 567890' }])).toBe(
      '+44 1234 567890'
    );
  });

  it('ignores non-phone questions even if their answer looks like a number', () => {
    expect(
      extractPhoneFromIntake([
        { question: 'Repair Type', answer: 'Type 2' },
        { question: 'Email', answer: 'a@b.com' },
      ])
    ).toBeNull();
  });

  it('returns null when the matched answer is empty/whitespace', () => {
    expect(extractPhoneFromIntake([{ question: 'Phone', answer: '   ' }])).toBeNull();
    expect(extractPhoneFromIntake([{ question: 'Phone', answer: '' }])).toBeNull();
  });

  it('returns the first match when there are multiple', () => {
    expect(
      extractPhoneFromIntake([
        { question: 'Contact Number', answer: '+44 1' },
        { question: 'Mobile', answer: '+44 2' },
      ])
    ).toBe('+44 1');
  });

  it('skips malformed entries', () => {
    expect(
      extractPhoneFromIntake([
        { question: null, answer: '+44 999' },
        { question: 'Phone', answer: '+44 7700 900900' },
      ] as Array<{ question?: string | null; answer?: string | null }>)
    ).toBe('+44 7700 900900');
  });
});
