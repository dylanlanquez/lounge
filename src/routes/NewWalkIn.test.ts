import { describe, it, expect } from 'vitest';
import { classifySearchTerm } from './NewWalkIn.tsx';

describe('classifySearchTerm', () => {
  it.each([
    ['alex@venneir.com', 'email'],
    ['ALEX@VENNEIR.COM', 'email'],
    ['x@y.z', 'email'],
    ['partial@', 'email'],
  ])('classifies "%s" as email', (term, kind) => {
    expect(classifySearchTerm(term)).toBe(kind);
  });

  it.each([
    ['07700 900000', 'phone'],
    ['+44 7700 900000', 'phone'],
    ['(0207) 946-0958', 'phone'],
    ['1234567', 'phone'],
    ['+1 415 555 0100', 'phone'],
  ])('classifies "%s" as phone', (term, kind) => {
    expect(classifySearchTerm(term)).toBe(kind);
  });

  it.each([
    ['Alex', 'name'],
    ['Alex Smith', 'name'],
    ['Mrs Elaine M James', 'name'],
    ['Dr John Stewart', 'name'],
    // Letters mixed in disqualify it from being a phone, so it falls
    // through to name even though it has digits.
    ['Patient 7', 'name'],
  ])('classifies "%s" as name', (term, kind) => {
    expect(classifySearchTerm(term)).toBe(kind);
  });

  it('treats too-short digit strings as name, not phone', () => {
    expect(classifySearchTerm('12345')).toBe('name');
  });

  it('trims whitespace before classifying', () => {
    expect(classifySearchTerm('  alex@venneir.com  ')).toBe('email');
  });
});
