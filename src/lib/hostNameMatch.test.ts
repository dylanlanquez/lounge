import { describe, expect, it } from 'vitest';
import {
  hostNameTokens,
  normalizeHostName,
  staffHostNameExact,
  staffHostNameMatches,
} from '../../supabase/functions/_shared/hostNameMatch.ts';

// The matcher is the security-sensitive heart of staff host recognition:
// too loose and a patient gets mislabelled as the host (hiding that they
// attended); too strict and a staff member who shows as "Karly" is never
// recognised. These cases pin both edges.

describe('normalizeHostName', () => {
  it('lower-cases, strips device tags and collapses whitespace', () => {
    expect(normalizeHostName('Karly  Innes  ')).toBe('karly innes');
    expect(normalizeHostName('Karly Innes (iPad)')).toBe('karly innes');
    expect(normalizeHostName('KARLY INNES (mobile)')).toBe('karly innes');
  });

  it('strips emoji and stray punctuation', () => {
    expect(normalizeHostName('Karly 🎉 Innes!')).toBe('karly innes');
  });
});

describe('hostNameTokens', () => {
  it('drops bare initials shorter than two characters', () => {
    expect(hostNameTokens('Karly K')).toEqual(['karly']);
    expect(hostNameTokens('K. Innes')).toEqual(['innes']);
  });
});

describe('staffHostNameMatches (loose label match)', () => {
  it('matches a first-name-only Meet display name to a full staff name', () => {
    expect(staffHostNameMatches('Karly Innes', 'Karly')).toBe(true);
  });

  it('matches a full staff name against a device-tagged Meet name', () => {
    expect(staffHostNameMatches('Karly Innes', 'Karly Innes (iPad)')).toBe(true);
  });

  it('matches regardless of order and case', () => {
    expect(staffHostNameMatches('Karly Innes', 'innes karly')).toBe(true);
  });

  it('does NOT match two different people who share only a surname-less first name', () => {
    // "John Smith" (staff) vs "John Doe" (patient): shorter is two tokens,
    // not a subset of the other, so no match.
    expect(staffHostNameMatches('John Smith', 'John Doe')).toBe(false);
  });

  it('does NOT match unrelated names', () => {
    expect(staffHostNameMatches('Karly Innes', 'Dawn Patient')).toBe(false);
  });

  it('returns false for empty / token-less names', () => {
    expect(staffHostNameMatches('Karly Innes', '')).toBe(false);
    expect(staffHostNameMatches('', 'Karly')).toBe(false);
    expect(staffHostNameMatches('Karly Innes', '🎉')).toBe(false);
  });

  it('accepts the residual single-token collision (documented trade-off)', () => {
    // A patient who types only "Karly" WILL match staff "Karly Innes".
    // This is the accepted flexibility cost; auto-bind stays strict so
    // it never persists the wrong id from this.
    expect(staffHostNameMatches('Karly Innes', 'Karly')).toBe(true);
  });
});

describe('staffHostNameExact (strict bind match)', () => {
  it('is true only when normalised names are equal', () => {
    expect(staffHostNameExact('Karly Innes', 'karly innes')).toBe(true);
    expect(staffHostNameExact('Karly Innes', 'Karly Innes (iPad)')).toBe(true);
  });

  it('is false for partial / first-name-only names', () => {
    expect(staffHostNameExact('Karly Innes', 'Karly')).toBe(false);
    expect(staffHostNameExact('Karly Innes', 'Karly I')).toBe(false);
  });

  it('is false for empty names', () => {
    expect(staffHostNameExact('', '')).toBe(false);
  });
});
