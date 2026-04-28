import { describe, expect, it } from 'vitest';
import { properCase } from './appointments.ts';

describe('properCase', () => {
  it('title-cases plain lowercase names', () => {
    expect(properCase('amanda')).toBe('Amanda');
    expect(properCase('amanda solanke')).toBe('Amanda Solanke');
  });

  it('title-cases ALL-CAPS names longer than three chars', () => {
    expect(properCase('AMANDA')).toBe('Amanda');
    expect(properCase('AMANDA SOLANKE')).toBe('Amanda Solanke');
  });

  it('preserves mixed-case names', () => {
    expect(properCase('McDonald')).toBe('McDonald');
    expect(properCase("O'Brien")).toBe("O'Brien");
  });

  it('handles hyphenated names', () => {
    expect(properCase('mary-jane')).toBe('Mary-Jane');
  });

  it('handles apostrophes (straight + curly)', () => {
    expect(properCase("o'brien")).toBe("O'Brien");
    expect(properCase('o’brien')).toBe('O’Brien');
  });

  it('returns empty for nullish input', () => {
    expect(properCase(null)).toBe('');
    expect(properCase(undefined)).toBe('');
    expect(properCase('')).toBe('');
  });

  it('title-cases short all-caps surnames (DOE → Doe, JO → Jo)', () => {
    // Patient-name domain — short all-caps tokens are surnames being
    // SHOUTED, not acronyms. The single-letter initials carve-out
    // covers the only legitimate uppercase-preserve case.
    expect(properCase('DOE')).toBe('Doe');
    expect(properCase('JO')).toBe('Jo');
  });

  it('treats single-letter tokens as initials and uppercases them', () => {
    expect(properCase('a v sinfield')).toBe('A V Sinfield');
    expect(properCase('A V Sinfield')).toBe('A V Sinfield');
  });

  it('proper-cases honorific titles regardless of case', () => {
    expect(properCase('MRS A V SINFIELD')).toBe('Mrs A V Sinfield');
    expect(properCase('miss a a abderrazig')).toBe('Miss A A Abderrazig');
    expect(properCase('DR JOHN SMITH')).toBe('Dr John Smith');
    expect(properCase('PROF JANE DOE')).toBe('Prof Jane Doe');
    expect(properCase('mr')).toBe('Mr');
    expect(properCase('MS')).toBe('Ms');
  });

  it('preserves a trailing dot on an honorific', () => {
    expect(properCase('MR. JOHN SMITH')).toBe('Mr. John Smith');
    expect(properCase('Dr. Jane')).toBe('Dr. Jane');
  });
});
