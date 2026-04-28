// Mirrors the extractDeposit() helper that lives inside the Calendly edge
// functions (supabase/functions/calendly-webhook + calendly-backfill). The
// edge functions run under Deno and can't import from src/, so the logic
// is duplicated by hand in both places. This test pins the contract so a
// drift between the two copies is at least caught by review.
//
// If the rules change here, update the helper in both edge functions.

import { describe, expect, it } from 'vitest';

interface CalendlyPayment {
  external_id?: string;
  provider?: string;
  amount?: number;
  currency?: string;
  successful?: boolean;
}

interface ExtractedDeposit {
  deposit_status: 'paid' | 'failed';
  deposit_pence: number;
  deposit_currency: string;
  deposit_provider: 'paypal' | 'stripe';
  deposit_external_id: string | null;
  deposit_paid_at: string;
}

function extractDeposit(
  payment: CalendlyPayment | null | undefined,
  fallbackPaidAt: string
): ExtractedDeposit | null {
  if (!payment || typeof payment.amount !== 'number') return null;
  const provider = (payment.provider ?? '').toLowerCase();
  if (provider !== 'paypal' && provider !== 'stripe') return null;
  return {
    deposit_status: payment.successful ? 'paid' : 'failed',
    deposit_pence: Math.round(payment.amount * 100),
    deposit_currency: (payment.currency ?? 'GBP').toUpperCase(),
    deposit_provider: provider,
    deposit_external_id: payment.external_id ?? null,
    deposit_paid_at: fallbackPaidAt,
  };
}

const NOW = '2026-04-28T13:00:00Z';

describe('extractDeposit', () => {
  it('returns null when payment is missing', () => {
    expect(extractDeposit(null, NOW)).toBeNull();
    expect(extractDeposit(undefined, NOW)).toBeNull();
  });

  it('captures failed payments with status="failed"', () => {
    const result = extractDeposit(
      { amount: 25, provider: 'paypal', successful: false, external_id: 'PAYID-X' },
      NOW
    );
    expect(result).toEqual({
      deposit_status: 'failed',
      deposit_pence: 2500,
      deposit_currency: 'GBP',
      deposit_provider: 'paypal',
      deposit_external_id: 'PAYID-X',
      deposit_paid_at: NOW,
    });
  });

  it('treats missing successful flag as failed (defensive)', () => {
    expect(
      extractDeposit({ amount: 25, provider: 'paypal' }, NOW)?.deposit_status
    ).toBe('failed');
  });

  it('returns null when amount is not a number', () => {
    expect(
      extractDeposit({ amount: undefined, provider: 'paypal', successful: true }, NOW)
    ).toBeNull();
  });

  it('returns null for unknown providers', () => {
    expect(
      extractDeposit({ amount: 25, provider: 'wechat', successful: true }, NOW)
    ).toBeNull();
    expect(extractDeposit({ amount: 25, provider: '', successful: true }, NOW)).toBeNull();
  });

  it('captures a valid PayPal deposit and converts pounds to pence', () => {
    const result = extractDeposit(
      { amount: 25, provider: 'paypal', currency: 'GBP', external_id: 'PAYID-X', successful: true },
      NOW
    );
    expect(result).toEqual({
      deposit_status: 'paid',
      deposit_pence: 2500,
      deposit_currency: 'GBP',
      deposit_provider: 'paypal',
      deposit_external_id: 'PAYID-X',
      deposit_paid_at: NOW,
    });
  });

  it('captures a Stripe deposit and lowercases the provider', () => {
    const result = extractDeposit(
      { amount: 50, provider: 'Stripe', currency: 'gbp', external_id: 'ch_X', successful: true },
      NOW
    );
    expect(result).toEqual({
      deposit_status: 'paid',
      deposit_pence: 5000,
      deposit_currency: 'GBP',
      deposit_provider: 'stripe',
      deposit_external_id: 'ch_X',
      deposit_paid_at: NOW,
    });
  });

  it('rounds fractional amounts to the nearest pence', () => {
    expect(
      extractDeposit({ amount: 25.5, provider: 'paypal', successful: true }, NOW)?.deposit_pence
    ).toBe(2550);
    expect(
      extractDeposit({ amount: 25.999, provider: 'paypal', successful: true }, NOW)?.deposit_pence
    ).toBe(2600);
  });

  it('defaults currency to GBP when missing', () => {
    expect(
      extractDeposit({ amount: 25, provider: 'paypal', successful: true }, NOW)?.deposit_currency
    ).toBe('GBP');
  });

  it('keeps external_id null when Calendly omits it', () => {
    expect(
      extractDeposit({ amount: 25, provider: 'paypal', successful: true }, NOW)?.deposit_external_id
    ).toBeNull();
  });
});
