import { describe, expect, it } from 'vitest';
import { batteryTone } from './useBattery.ts';

describe('batteryTone', () => {
  it('returns "ok" when level is unknown (null)', () => {
    expect(batteryTone(null)).toBe('ok');
  });

  it('flips to "low" at 20% and below', () => {
    expect(batteryTone(21)).toBe('ok');
    expect(batteryTone(20)).toBe('low');
    expect(batteryTone(15)).toBe('low');
    expect(batteryTone(11)).toBe('low');
  });

  it('flips to "critical" at 10% and below', () => {
    expect(batteryTone(11)).toBe('low');
    expect(batteryTone(10)).toBe('critical');
    expect(batteryTone(5)).toBe('critical');
    expect(batteryTone(0)).toBe('critical');
  });

  it('returns "ok" for healthy levels', () => {
    expect(batteryTone(100)).toBe('ok');
    expect(batteryTone(50)).toBe('ok');
    expect(batteryTone(30)).toBe('ok');
  });
});
