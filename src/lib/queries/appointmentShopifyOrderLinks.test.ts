import { describe, expect, it } from 'vitest';
import { orderTotalToPence } from './appointmentShopifyOrderLinks.ts';
import { orderStatusLabel } from '../../components/ShopifyOrderPicker/ShopifyOrderPicker.tsx';
import type { PatientShopifyOrderRow } from './patientProfile.ts';

function order(partial: Partial<PatientShopifyOrderRow>): PatientShopifyOrderRow {
  return {
    id: '1',
    name: 'VEN1',
    created_at: '2026-10-01T00:00:00Z',
    total_price: 299,
    currency: 'GBP',
    financial_status: 'paid',
    fulfillment_status: null,
    cancelled_at: null,
    refund_amount: null,
    items: [],
    ...partial,
  };
}

describe('orderTotalToPence', () => {
  it('converts pounds to integer pence', () => {
    expect(orderTotalToPence(299)).toBe(29900);
    expect(orderTotalToPence(69.95)).toBe(6995);
    // 19.99 * 100 is 1998.9999... in binary floating point — rounding,
    // not truncation, is what keeps the till honest.
    expect(orderTotalToPence(19.99)).toBe(1999);
  });

  it('keeps a missing total missing rather than turning it into zero', () => {
    expect(orderTotalToPence(null)).toBeNull();
    expect(orderTotalToPence(undefined)).toBeNull();
    expect(orderTotalToPence(Number.NaN)).toBeNull();
  });
});

describe('orderStatusLabel', () => {
  it('leads with cancelled and refunded over the financial status', () => {
    expect(orderStatusLabel(order({ cancelled_at: '2026-09-01T00:00:00Z' }))).toBe('Cancelled');
    expect(orderStatusLabel(order({ financial_status: 'refunded' }))).toBe('Refunded');
    expect(orderStatusLabel(order({ financial_status: 'partially_refunded' }))).toBe(
      'Partly refunded',
    );
  });

  it('separates paid from paid-and-fulfilled', () => {
    expect(orderStatusLabel(order({ fulfillment_status: null }))).toBe('Paid');
    expect(orderStatusLabel(order({ fulfillment_status: 'fulfilled' }))).toBe('Paid, fulfilled');
  });

  it('humanises anything else and never renders an empty label', () => {
    expect(orderStatusLabel(order({ financial_status: 'pending' }))).toBe('Pending');
    expect(orderStatusLabel(order({ financial_status: null }))).toBe('Unknown status');
  });
});
