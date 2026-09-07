// @vitest-environment jsdom
//
// Currency inputs show thousands separators on screen while handing the
// caller the plain value. Every £ field in Lounge (Pay, discounts,
// product prices, Cash counts) goes through this path.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Input, formatCurrencyDisplay } from './Input.tsx';

afterEach(cleanup);

function Harness({ onValue }: { onValue: (v: string) => void }) {
  const [value, setValue] = useState('');
  return (
    <Input
      label="Amount (£)"
      numericFormat="currency"
      value={value}
      onChange={(e) => {
        setValue(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}

describe('formatCurrencyDisplay', () => {
  it('groups thousands and keeps the fraction', () => {
    expect(formatCurrencyDisplay('44444')).toBe('44,444');
    expect(formatCurrencyDisplay('2076.16')).toBe('2,076.16');
    expect(formatCurrencyDisplay('1234567.5')).toBe('1,234,567.5');
    expect(formatCurrencyDisplay('999')).toBe('999');
  });

  it('keeps a trailing decimal point while typing', () => {
    expect(formatCurrencyDisplay('1000.')).toBe('1,000.');
    expect(formatCurrencyDisplay('')).toBe('');
  });
});

describe('Input currency formatting', () => {
  it('shows separators on screen and gives the caller the plain value', () => {
    const seen: string[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Amount (£)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '4444' } });
    expect(input.value).toBe('4,444');
    fireEvent.change(input, { target: { value: '4,4445' } });
    expect(input.value).toBe('44,445');
    fireEvent.change(input, { target: { value: '44,445.5' } });
    expect(input.value).toBe('44,445.5');
    expect(seen).toEqual(['4444', '44445', '44445.5']);
  });

  it('never lets more than two fraction digits through', () => {
    const seen: string[] = [];
    render(<Harness onValue={(v) => seen.push(v)} />);
    const input = screen.getByLabelText('Amount (£)') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '2076.169' } });
    expect(input.value).toBe('2,076.16');
    expect(seen).toEqual(['2076.16']);
  });
});
