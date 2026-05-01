import { describe, expect, it } from 'vitest';
import { titleCase } from './text.ts';

describe('titleCase', () => {
  it('returns empty for null / undefined / empty input', () => {
    expect(titleCase(null)).toBe('');
    expect(titleCase(undefined)).toBe('');
    expect(titleCase('')).toBe('');
  });

  it('capitalises the first letter of all-lowercase words', () => {
    expect(titleCase('facebook')).toBe('Facebook');
    expect(titleCase('google ads')).toBe('Google Ads');
    expect(titleCase('friend recommendation')).toBe('Friend Recommendation');
  });

  it('preserves already-correct mixed casing', () => {
    expect(titleCase('iPhone repair')).toBe('iPhone Repair');
    expect(titleCase('TikTok')).toBe('TikTok');
  });

  it('preserves all-uppercase tokens as acronyms', () => {
    expect(titleCase('BBC')).toBe('BBC');
    expect(titleCase('BBC News')).toBe('BBC News');
    expect(titleCase('NHS GP referral')).toBe('NHS GP Referral');
  });

  it('handles separators (space, hyphen, slash, ampersand, middot)', () => {
    expect(titleCase('walk-in')).toBe('Walk-In');
    expect(titleCase('mum & dad')).toBe('Mum & Dad');
    expect(titleCase('google/instagram')).toBe('Google/Instagram');
    expect(titleCase('one · two')).toBe('One · Two');
  });

  it('preserves multiple internal spaces', () => {
    expect(titleCase('one  two')).toBe('One  Two');
  });
});
