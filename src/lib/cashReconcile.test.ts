import { describe, expect, it } from 'vitest';
import {
  buildActivityStatement,
  buildCashActivityCsv,
  buildEnvelopeListCsv,
  envelopeListSince,
  findCombinations,
  findDifferenceClues,
} from './cashReconcile.ts';
import type {
  CashClueOpenBalance,
  CashClueOtherPayment,
  CashPosition,
  CashPositionLine,
} from './queries/cashCounts.ts';

// ── Fixtures ────────────────────────────────────────────────────────────────

function payment(
  id: string,
  amount: number,
  at: string,
  name = 'Alex Smith',
  takenBy = 'Jade Cassidy',
): CashPositionLine {
  return {
    kind: 'payment',
    payment_id: id,
    amount_pence: amount,
    taken_at: at,
    patient_name: name,
    appointment_ref: `LAP-${id}`,
    visit_id: `v-${id}`,
    taken_by_name: takenBy,
    cart_total_pence: amount,
  };
}

function withdrawal(id: string, amount: number, at: string): CashPositionLine {
  return {
    kind: 'withdrawal',
    withdrawal_id: id,
    amount_pence: amount,
    taken_at: at,
    reason: 'bank_deposit',
    note: null,
    taken_by_name: 'Dylan Lane',
    witness_name: 'Robert McCrindle',
    on_camera: true,
    reversed_at: null,
    reversal_reason: null,
    reversed_by_name: null,
    put_back: false,
  };
}

function card(id: string, amount: number, at: string, name = 'Card Payer'): CashClueOtherPayment {
  return {
    payment_id: id,
    method: 'card_terminal',
    amount_pence: amount,
    taken_at: at,
    patient_name: name,
    appointment_ref: `LAP-${id}`,
    visit_id: `v-${id}`,
    taken_by_name: 'Lisa Mccomb',
  };
}

function owed(id: string, amount: number, at: string): CashClueOpenBalance {
  return {
    visit_id: `v-${id}`,
    opened_at: at,
    owed_pence: amount,
    patient_name: 'Owes Money',
    appointment_ref: `LAP-${id}`,
  };
}

function position(overrides: Partial<CashPosition> = {}): CashPosition {
  const lines = overrides.lines ?? [];
  const baseline = overrides.baseline_pence ?? 0;
  const expected = lines.reduce((s, l) => {
    if (l.kind === 'payment') return s + l.amount_pence;
    if (l.kind === 'withdrawal' || l.kind === 'refund') return s - l.amount_pence;
    return s;
  }, baseline);
  return {
    expected_in_safe_pence: expected,
    baseline_pence: baseline,
    period_start: '2026-07-03T17:54:28Z',
    period_end: '2026-09-07T10:00:00Z',
    payment_count: lines.filter((l) => l.kind === 'payment').length,
    withdrawal_count: lines.filter((l) => l.kind === 'withdrawal').length,
    refund_count: 0,
    refunded_sale_count: 0,
    earliest_payment_at: null,
    latest_payment_at: null,
    last_signed_count: null,
    clues: { other_payments: [], open_balances: [] },
    ...overrides,
    lines,
  };
}

// The real 7 Sep 2026 scenario: £560 opening, £560 banked, whole-pound
// cash payments, counted £127.16 over.
const REAL = position({
  baseline_pence: 56000,
  lines: [
    withdrawal('w1', 56000, '2026-07-03T17:55:04Z'),
    payment('p1', 7000, '2026-07-08T10:48:41Z', 'John Kerr', 'Karly Innes'),
    payment('p2', 4000, '2026-07-08T13:39:32Z', 'Lynn Reid'),
    payment('p3', 17400, '2026-07-08T15:13:08Z', 'Stewart Armstrong'),
    payment('p4', 27500, '2026-08-31T13:34:56Z', 'Alexander Waldron', 'Karly Innes'),
  ],
  last_signed_count: {
    id: 'c1',
    period_end: '2026-07-03T17:54:28Z',
    actual_pence: 56000,
    expected_pence: 56000,
    variance_pence: 0,
    signed_off_at: '2026-07-03T17:54:39Z',
  },
  clues: {
    other_payments: [card('k1', 28995, '2026-07-20T08:11:37Z'), card('k2', 2407, '2026-08-03T11:19:06Z')],
    open_balances: [owed('o1', 2000, '2026-08-07T12:47:56Z'), owed('o2', 6000, '2026-09-07T08:40:16Z')],
  },
});

// ── findCombinations ────────────────────────────────────────────────────────

describe('findCombinations', () => {
  it('finds pairs and triples that sum to the target, ignoring items at or over it', () => {
    const items = [10, 20, 30, 40, 100];
    const r = findCombinations(items, (x) => x, 60);
    expect(r).toContainEqual([20, 40]);
    expect(r).toContainEqual([10, 20, 30]);
    // 100 is over the target and 60 itself is not a combination.
    expect(r.every((set) => set.every((x) => x < 60))).toBe(true);
  });

  it('caps the number of results', () => {
    const items = Array.from({ length: 40 }, () => 50);
    expect(findCombinations(items, (x) => x, 100, 3)).toHaveLength(3);
  });

  it('returns nothing for a non-positive target', () => {
    expect(findCombinations([1, 2], (x) => x, 0)).toEqual([]);
  });
});

// ── findDifferenceClues ─────────────────────────────────────────────────────

describe('findDifferenceClues', () => {
  it('returns nothing when the count matches', () => {
    expect(findDifferenceClues({ diff_pence: 0, position: REAL })).toEqual([]);
  });

  it('explains the real £127.16 surplus: pence can only be coins, nothing recorded matches', () => {
    const clues = findDifferenceClues({ diff_pence: 12716, position: REAL, coins_pence: 12716 });
    const kinds = clues.map((c) => c.kind);
    expect(kinds[0]).toBe('pence');
    expect(clues[0]?.tone).toBe('strong');
    expect(clues[0]?.title).toContain('£0.16');
    expect(clues[0]?.detail).toContain('£127.16 in coins');
    // No card payment or owed visit equals £127.16.
    expect(kinds).not.toContain('exact_card');
    expect(kinds).not.toContain('open_balance_exact');
    // The two owed visits are listed as context.
    const anyOwed = clues.find((c) => c.kind === 'open_balance_any');
    expect(anyOwed?.matches).toHaveLength(2);
    // Verdict: money went in without being recorded.
    expect(kinds).toContain('likely_unrecorded');
  });

  it('flags a surplus that exactly equals one card payment as strong', () => {
    const clues = findDifferenceClues({ diff_pence: 28995, position: REAL });
    const exact = clues.find((c) => c.kind === 'exact_card');
    expect(exact?.tone).toBe('strong');
    expect(exact?.matches[0]?.[0]?.amount_pence).toBe(28995);
    // With a strong explanation there is no "most likely unrecorded" verdict.
    expect(clues.map((c) => c.kind)).not.toContain('likely_unrecorded');
  });

  it('flags a surplus that equals a visit still owed', () => {
    const clues = findDifferenceClues({ diff_pence: 6000, position: REAL });
    const exact = clues.find((c) => c.kind === 'open_balance_exact');
    expect(exact?.tone).toBe('strong');
    expect(exact?.matches[0]?.[0]?.visit_id).toBe('v-o2');
  });

  it('finds two card payments that add up to the surplus', () => {
    const clues = findDifferenceClues({ diff_pence: 28995 + 2407, position: REAL });
    const combo = clues.find((c) => c.kind === 'combo_card');
    expect(combo?.matches[0]).toHaveLength(2);
  });

  it('flags a shortfall equal to one cash payment and names who took it', () => {
    const clues = findDifferenceClues({ diff_pence: -17400, position: REAL });
    const exact = clues.find((c) => c.kind === 'exact_cash');
    expect(exact?.tone).toBe('strong');
    expect(exact?.matches[0]?.[0]?.label).toBe('Stewart Armstrong');
    expect(exact?.matches[0]?.[0]?.sub).toContain('taken by Jade Cassidy');
  });

  it('finds cash payments that add up to a shortfall', () => {
    const clues = findDifferenceClues({ diff_pence: -11000, position: REAL });
    const combo = clues.find((c) => c.kind === 'combo_cash');
    expect(combo?.matches[0]?.map((m) => m.amount_pence).sort()).toEqual([4000, 7000]);
  });

  it('suggests an unrecorded withdrawal for a round shortfall', () => {
    const clues = findDifferenceClues({ diff_pence: -20000, position: REAL });
    expect(clues.map((c) => c.kind)).toContain('round_withdrawal');
    expect(clues.map((c) => c.kind)).toContain('unexplained');
  });

  it('does not run the pence test when a recorded line itself has pence', () => {
    const p = position({ lines: [payment('p1', 2895, '2026-08-01T10:00:00Z')] });
    const clues = findDifferenceClues({ diff_pence: 95, position: p });
    expect(clues.map((c) => c.kind)).not.toContain('pence');
  });

  it('mentions a carried-over difference from the previous count', () => {
    const p = position({
      lines: [payment('p1', 5000, '2026-08-01T10:00:00Z')],
      last_signed_count: {
        id: 'c0',
        period_end: '2026-07-01T00:00:00Z',
        actual_pence: 1000,
        expected_pence: 1500,
        variance_pence: -500,
        signed_off_at: '2026-07-01T00:00:00Z',
      },
    });
    const clues = findDifferenceClues({ diff_pence: -500, position: p });
    const prior = clues.find((c) => c.kind === 'prior_count');
    expect(prior?.title).toContain('£5.00 short');
  });
});

// ── Statement + CSV ─────────────────────────────────────────────────────────

describe('buildActivityStatement', () => {
  it('runs oldest-first from the opening balance to the expected figure', () => {
    const rows = buildActivityStatement(REAL);
    expect(rows[0]?.type).toContain('Taken from safe');
    expect(rows[0]?.balance_pence).toBe(0);
    expect(rows[rows.length - 1]?.balance_pence).toBe(REAL.expected_in_safe_pence);
  });

  it('throws loudly if the lines do not add up to the headline figure', () => {
    const broken = { ...REAL, expected_in_safe_pence: REAL.expected_in_safe_pence + 1 };
    expect(() => buildActivityStatement(broken)).toThrow(/does not|lines total/);
  });
});

describe('buildCashActivityCsv', () => {
  it('produces a header, opening row, one row per line, and the expected row', () => {
    const csv = buildCashActivityCsv(REAL);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Date,Time,Type,Detail,Reference,Taken by,In (£),Out (£),Balance (£),Checked');
    expect(lines[1]).toContain('Opening balance');
    expect(lines[1]).toContain('560.00');
    expect(lines).toHaveLength(2 + REAL.lines.length + 1);
    expect(lines[lines.length - 1]).toContain('Expected in safe');
    expect(lines[lines.length - 1]).toContain('559.00');
  });

  it('quotes fields that contain commas', () => {
    const p = position({
      lines: [
        {
          kind: 'withdrawal',
          withdrawal_id: 'w',
          amount_pence: 100,
          taken_at: '2026-08-01T10:00:00Z',
          reason: 'other',
          note: 'Lloyds drop, slip #84',
          taken_by_name: 'Dylan Lane',
          witness_name: null,
          on_camera: null,
          reversed_at: null,
          reversal_reason: null,
          reversed_by_name: null,
          put_back: false,
        },
      ],
      baseline_pence: 100,
    });
    expect(buildCashActivityCsv(p)).toContain('"Lloyds drop, slip #84"');
  });
});

describe('envelope list', () => {
  it('lists cash payments since the last time cash was taken out, oldest first', () => {
    const { since, rows } = envelopeListSince(REAL);
    expect(since).toBe('2026-07-03T17:55:04Z');
    expect(rows.map((r) => r.order_ref)).toEqual(['LAP-p1', 'LAP-p2', 'LAP-p3', 'LAP-p4']);
    expect(rows[0]?.customer_name).toBe('John Kerr');
  });

  it('falls back to the count window when nothing has been taken out', () => {
    const p = position({ lines: [payment('p1', 5000, '2026-08-01T10:00:00Z')] });
    expect(envelopeListSince(p).since).toBe(p.period_start);
  });

  it('builds a CSV with order number, customer, amount, and a blank Envelope found column', () => {
    const csv = buildEnvelopeListCsv(REAL);
    const lines = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
    expect(lines[0]).toBe('Order number,Customer,Amount (£),Date,Time,Taken by,Envelope found');
    expect(lines[1]).toContain('LAP-p1,John Kerr,70.00');
    expect(lines[lines.length - 1]).toContain('Total,,559.00');
  });
});
