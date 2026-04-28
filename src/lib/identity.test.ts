import { describe, expect, it } from 'vitest';
import { isPlaceholderEmail } from './identity.ts';

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
