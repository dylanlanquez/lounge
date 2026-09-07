// Cash count reconciliation — the detective work that runs the moment a
// physical count disagrees with the recorded figure.
//
// Everything here is pure: it takes the authoritative CashPosition (from
// lng_cash_safe_position, clues included) plus the counted amount, and
// returns plain-English clues ranked by how strongly they explain the
// difference. No fetching, no side effects, fully unit-tested.
//
// The methods are the ones a bookkeeper would use by hand, automated:
//
//   1. Pence test. Recorded cash payments are almost always whole
//      pounds. If the difference has pence, that part can only be coins
//      that were never logged (a float, loose change, coins missed at
//      the previous count).
//   2. Exact match. A surplus that equals one card payment is almost
//      always a patient who paid cash while the payment was logged as
//      card. A shortfall that equals one cash payment is cash that never
//      reached the safe (or was handed back without a refund record).
//   3. Combination match. The same, for two or three payments together.
//   4. Unlogged sales. Visits in the period that still owe money are
//      candidates for "cash taken, payment never recorded".
//   5. Round amounts. A round shortfall looks like a bank drop or petty
//      cash that was taken without using Take from safe.
//   6. Carried difference. If the previous count was already over or
//      short, part of today's difference may not be new.
//
// Alongside the clues, the count sheet offers the tick-off checklist and
// the CSV / PDF exports built here, so staff can check every recorded
// payment against receipts and paperwork.

import {
  type CashClueOpenBalance,
  type CashClueOtherPayment,
  type CashPosition,
  type CashPositionLine,
  type CashPositionPaymentLine,
  withdrawalReasonLabel,
} from './queries/cashCounts.ts';
import { fmtTzAbbr } from './dateFormat.ts';

export type CashClueKind =
  | 'pence'
  | 'exact_card'
  | 'combo_card'
  | 'open_balance_exact'
  | 'open_balance_any'
  | 'exact_cash'
  | 'combo_cash'
  | 'round_withdrawal'
  | 'prior_count'
  | 'likely_unrecorded'
  | 'unexplained';

/** strong: this alone explains the difference to the penny.
 *  possible: worth checking, does not prove anything on its own.
 *  info: context that helps the reader, not a candidate explanation. */
export type CashClueTone = 'strong' | 'possible' | 'info';

export interface CashClueMatchLine {
  label: string;
  sub: string;
  amount_pence: number;
  visit_id: string | null;
}

export interface CashClue {
  kind: CashClueKind;
  tone: CashClueTone;
  title: string;
  detail: string;
  /** Each entry is one candidate: a single line, or the two/three lines
   *  that add up to the difference together. */
  matches: CashClueMatchLine[][];
}

export interface FindCluesInput {
  /** counted − expected, in pence. Positive = over, negative = short. */
  diff_pence: number;
  position: CashPosition;
  /** Total value of the coins counted, when the count was entered by
   *  denomination. Lets the pence clue say how much of the surplus is
   *  loose change. */
  coins_pence?: number | null;
}

const MAX_COMBO_RESULTS = 4;

function formatGbp(pence: number): string {
  return `£${(Math.abs(pence) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatWhen(iso: string): string {
  const stamp = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
  return `${stamp} ${fmtTzAbbr(iso)}`;
}

function methodLabel(method: string): string {
  switch (method) {
    case 'card_terminal':
      return 'Card';
    case 'card_moto':
      return 'Card over the phone';
    case 'cash':
      return 'Cash';
    default:
      return method.replace(/_/g, ' ');
  }
}

function paymentMatch(l: CashPositionPaymentLine): CashClueMatchLine {
  const sub = [formatWhen(l.taken_at), l.appointment_ref, `taken by ${l.taken_by_name}`]
    .filter((s): s is string => !!s)
    .join(' · ');
  return { label: l.patient_name, sub, amount_pence: l.amount_pence, visit_id: l.visit_id };
}

function otherPaymentMatch(p: CashClueOtherPayment): CashClueMatchLine {
  const sub = [formatWhen(p.taken_at), methodLabel(p.method), p.appointment_ref, `taken by ${p.taken_by_name}`]
    .filter((s): s is string => !!s)
    .join(' · ');
  return { label: p.patient_name, sub, amount_pence: p.amount_pence, visit_id: p.visit_id };
}

function openBalanceMatch(b: CashClueOpenBalance): CashClueMatchLine {
  const sub = [formatWhen(b.opened_at), b.appointment_ref, 'still shows as owed']
    .filter((s): s is string => !!s)
    .join(' · ');
  return { label: b.patient_name, sub, amount_pence: b.owed_pence, visit_id: b.visit_id };
}

/** Every set of 2 or 3 items whose amounts add up to `target`, up to
 *  `maxResults` sets. Items over the target are dropped first, so the
 *  search is small even on a busy period. Exported for tests. */
export function findCombinations<T>(
  items: T[],
  amountOf: (item: T) => number,
  target: number,
  maxResults: number = MAX_COMBO_RESULTS,
): T[][] {
  if (target <= 0) return [];
  const pool = items.filter((i) => amountOf(i) > 0 && amountOf(i) < target);
  const out: T[][] = [];
  const n = pool.length;
  for (let i = 0; i < n && out.length < maxResults; i += 1) {
    const a = amountOf(pool[i]!);
    for (let j = i + 1; j < n && out.length < maxResults; j += 1) {
      const ab = a + amountOf(pool[j]!);
      if (ab === target) out.push([pool[i]!, pool[j]!]);
    }
  }
  for (let i = 0; i < n && out.length < maxResults; i += 1) {
    const a = amountOf(pool[i]!);
    for (let j = i + 1; j < n && out.length < maxResults; j += 1) {
      const ab = a + amountOf(pool[j]!);
      if (ab >= target) continue;
      for (let k = j + 1; k < n && out.length < maxResults; k += 1) {
        if (ab + amountOf(pool[k]!) === target) out.push([pool[i]!, pool[j]!, pool[k]!]);
      }
    }
  }
  return out;
}

function linesWithPence(lines: CashPositionLine[]): boolean {
  return lines.some((l) => l.amount_pence % 100 !== 0);
}

export function findDifferenceClues(input: FindCluesInput): CashClue[] {
  const { diff_pence, position } = input;
  if (diff_pence === 0) return [];
  const over = diff_pence > 0;
  const magnitude = Math.abs(diff_pence);
  const clues: CashClue[] = [];
  const paymentLines = position.lines.filter((l): l is CashPositionPaymentLine => l.kind === 'payment');
  const otherPayments = position.clues?.other_payments ?? [];
  const openBalances = position.clues?.open_balances ?? [];

  // 1. Pence test — applies to both directions.
  const pencePart = magnitude % 100;
  if (pencePart !== 0 && !linesWithPence(position.lines) && position.baseline_pence % 100 === 0) {
    const coins = input.coins_pence ?? null;
    clues.push({
      kind: 'pence',
      tone: 'strong',
      title: over
        ? `${formatGbp(pencePart)} of the extra can only be coins that were never recorded`
        : `${formatGbp(pencePart)} of the shortfall can only be coins`,
      detail: over
        ? `Every cash payment recorded in this period is a whole number of pounds, so no logged payment can produce ${formatGbp(pencePart)}. Loose change, a float kept for giving change, or coins that were left out of the last count would all explain it.${
            coins !== null && coins > 0 ? ` You counted ${formatGbp(coins)} in coins today.` : ''
          }`
        : `Every recorded line in this period is a whole number of pounds. Check that all coins were counted, including any bagged change, and that nothing was left in a till drawer.`,
      matches: [],
    });
  }

  if (over) {
    // 2. Exactly one card payment.
    const exactCard = otherPayments.filter((p) => p.amount_pence === magnitude);
    if (exactCard.length > 0) {
      clues.push({
        kind: 'exact_card',
        tone: 'strong',
        title: `A card payment for exactly ${formatGbp(magnitude)}`,
        detail:
          'If this patient actually handed over cash, the money is in the safe but Lounge has it logged as card. Check the card terminal history for a matching charge. If there is none, the payment method was recorded wrongly.',
        matches: exactCard.map((p) => [otherPaymentMatch(p)]),
      });
    }
    // 3. Two or three card payments together.
    const comboCard = findCombinations(otherPayments, (p) => p.amount_pence, magnitude);
    if (comboCard.length > 0) {
      clues.push({
        kind: 'combo_card',
        tone: 'possible',
        title: `Card payments that add up to ${formatGbp(magnitude)} together`,
        detail:
          'Less likely than a single match, but worth a glance: two or three payments logged as card whose totals happen to equal the difference.',
        matches: comboCard.map((set) => set.map(otherPaymentMatch)),
      });
    }
    // 4. Unlogged sale: a visit still owing exactly the difference.
    const exactOwed = openBalances.filter((b) => b.owed_pence === magnitude);
    if (exactOwed.length > 0) {
      clues.push({
        kind: 'open_balance_exact',
        tone: 'strong',
        title: `A visit still owes exactly ${formatGbp(magnitude)}`,
        detail:
          'The cash may have been taken without the payment being recorded. Open the visit and take the payment as cash if that is what happened.',
        matches: exactOwed.map((b) => [openBalanceMatch(b)]),
      });
    } else {
      const comboOwed = findCombinations(openBalances, (b) => b.owed_pence, magnitude);
      if (comboOwed.length > 0) {
        clues.push({
          kind: 'open_balance_exact',
          tone: 'possible',
          title: `Visits that together still owe ${formatGbp(magnitude)}`,
          detail:
            'Two or three visits from this period still show money owed, and their balances add up to the difference. Cash may have been taken for them without being recorded.',
          matches: comboOwed.map((set) => set.map(openBalanceMatch)),
        });
      }
    }
    if (exactOwed.length === 0 && openBalances.length > 0) {
      clues.push({
        kind: 'open_balance_any',
        tone: 'info',
        title: `${openBalances.length} visit${openBalances.length === 1 ? '' : 's'} in this period still show${openBalances.length === 1 ? 's' : ''} money owed`,
        detail:
          'None of them matches the difference on its own. If any of these patients actually paid in cash, record the payment on the visit and the safe figure will correct itself.',
        matches: openBalances.map((b) => [openBalanceMatch(b)]),
      });
    }
  } else {
    // 2. Exactly one cash payment.
    const exactCash = paymentLines.filter((l) => l.amount_pence === magnitude);
    if (exactCash.length > 0) {
      clues.push({
        kind: 'exact_cash',
        tone: 'strong',
        title: `A cash payment for exactly ${formatGbp(magnitude)}`,
        detail:
          'This payment is recorded, but its cash may never have reached the safe, or it was handed back without a refund being logged. Confirm with whoever took it before signing.',
        matches: exactCash.map((l) => [paymentMatch(l)]),
      });
    }
    // 3. Two or three cash payments together.
    const comboCash = findCombinations(paymentLines, (l) => l.amount_pence, magnitude);
    if (comboCash.length > 0) {
      clues.push({
        kind: 'combo_cash',
        tone: 'possible',
        title: `Cash payments that add up to ${formatGbp(magnitude)} together`,
        detail:
          'Two or three recorded cash payments whose totals equal the shortfall. Check each one against its receipt using the list below.',
        matches: comboCash.map((set) => set.map(paymentMatch)),
      });
    }
    // 4. Round amount: looks like an unrecorded withdrawal.
    if (magnitude % 1000 === 0 && magnitude >= 2000) {
      clues.push({
        kind: 'round_withdrawal',
        tone: 'possible',
        title: 'A round amount, like a bank drop or petty cash',
        detail:
          'Cash taken out for banking, a float, or an expense without using Take from safe looks exactly like this. If that is what happened, close this sheet, record it with Take from safe, and count again.',
        matches: [],
      });
    }
  }

  // 5. Carried difference from the previous count.
  const last = position.last_signed_count;
  if (last && last.variance_pence !== 0) {
    const lastOver = last.variance_pence > 0;
    clues.push({
      kind: 'prior_count',
      tone: 'info',
      title: `The last count was already ${formatGbp(last.variance_pence)} ${lastOver ? 'over' : 'short'}`,
      detail: `Today's figure starts from what was counted last time, so a difference found then does not repeat here. If the same cause is still in play, expect a similar pattern.`,
      matches: [],
    });
  }

  // 6. Verdict when nothing pins it down.
  const hasStrong = clues.some((c) => c.tone === 'strong' && c.kind !== 'pence');
  if (!hasStrong) {
    if (over) {
      clues.push({
        kind: 'likely_unrecorded',
        tone: 'info',
        title: 'Most likely: cash went into the safe without being recorded in Lounge',
        detail:
          'Nothing recorded matches the difference, so the extra money did not come from a logged transaction. Common causes: a change float or coins that were not part of the last count, a product or top-up paid in cash and never entered, or a patient who paid cash on a visit that was logged as card. Tick off the payments below against your receipts, then write what you find in the note.',
        matches: [],
      });
    } else {
      clues.push({
        kind: 'unexplained',
        tone: 'info',
        title: 'Nothing recorded matches the shortfall',
        detail:
          'Tick off every payment below against its receipt to find which cash never reached the safe. Check for change given from the safe, refunds handed back without a record, and any cash removed without Take from safe. Write what you find in the note before signing.',
        matches: [],
      });
    }
  }

  return clues;
}

// ── Exports: CSV ────────────────────────────────────────────────────────────
//
// One row per movement, oldest first, with a running balance so the
// sheet reads like a bank statement. A blank "Checked" column is there
// for ticking against receipts on paper.

function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvGbp(pence: number): string {
  return (pence / 100).toFixed(2);
}

function londonDate(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(iso));
}

function londonTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

export interface ActivityStatementRow {
  when: string;
  type: string;
  detail: string;
  reference: string | null;
  taken_by: string | null;
  in_pence: number;
  out_pence: number;
  balance_pence: number;
  visit_id: string | null;
}

/** Chronological (oldest first) statement rows with a running balance
 *  that starts at the opening figure and ends on the expected figure. */
export function buildActivityStatement(position: CashPosition): ActivityStatementRow[] {
  const ordered = [...position.lines].sort((a, b) => a.taken_at.localeCompare(b.taken_at));
  let balance = position.baseline_pence;
  const rows: ActivityStatementRow[] = [];
  for (const l of ordered) {
    switch (l.kind) {
      case 'payment':
        balance += l.amount_pence;
        rows.push({
          when: l.taken_at,
          type: 'Cash payment',
          detail: l.patient_name,
          reference: l.appointment_ref,
          taken_by: l.taken_by_name,
          in_pence: l.amount_pence,
          out_pence: 0,
          balance_pence: balance,
          visit_id: l.visit_id,
        });
        break;
      case 'refunded_sale':
        rows.push({
          when: l.taken_at,
          type: 'Cash payment, refunded in full',
          detail: l.patient_name,
          reference: null,
          taken_by: l.taken_by_name,
          in_pence: 0,
          out_pence: 0,
          balance_pence: balance,
          visit_id: l.visit_id,
        });
        break;
      case 'refund':
        balance -= l.amount_pence;
        rows.push({
          when: l.taken_at,
          type: 'Cash refund',
          detail: l.patient_name ?? 'Refund against an earlier sale',
          reference: null,
          taken_by: null,
          in_pence: 0,
          out_pence: l.amount_pence,
          balance_pence: balance,
          visit_id: null,
        });
        break;
      case 'adjustment':
        balance += l.amount_pence;
        rows.push({
          when: l.taken_at,
          type: l.amount_pence > 0 ? 'Put back into the safe' : 'Adjustment',
          detail: [l.withdrawal_note ? `${l.withdrawal_note} reversed` : null, l.reason].filter(Boolean).join(' · '),
          reference: null,
          taken_by: l.made_by_name,
          in_pence: l.amount_pence > 0 ? l.amount_pence : 0,
          out_pence: l.amount_pence < 0 ? -l.amount_pence : 0,
          balance_pence: balance,
          visit_id: null,
        });
        break;
      case 'withdrawal':
        if (l.reversed_at) {
          // Reversed by the super admin: stays on the statement for
          // the record, moves nothing.
          rows.push({
            when: l.taken_at,
            type: `Taken from safe, reversed: ${withdrawalReasonLabel(l.reason)}`,
            detail: [l.note, l.reversal_reason ? `Reversed: ${l.reversal_reason}` : null].filter(Boolean).join(' · '),
            reference: null,
            taken_by: l.taken_by_name,
            in_pence: 0,
            out_pence: 0,
            balance_pence: balance,
            visit_id: null,
          });
          break;
        }
        balance -= l.amount_pence;
        rows.push({
          when: l.taken_at,
          type: `Taken from safe: ${withdrawalReasonLabel(l.reason)}`,
          detail: l.note ?? '',
          reference: null,
          taken_by: l.taken_by_name,
          in_pence: 0,
          out_pence: l.amount_pence,
          balance_pence: balance,
          visit_id: null,
        });
        break;
    }
  }
  if (balance !== position.expected_in_safe_pence) {
    // The server's headline and its own lines must agree. If they do
    // not, the export would be lying; fail loudly instead.
    throw new Error(
      `cash statement: lines total ${balance} pence but expected_in_safe_pence is ${position.expected_in_safe_pence}`,
    );
  }
  return rows;
}

export function buildCashActivityCsv(position: CashPosition): string {
  const rows = buildActivityStatement(position);
  const header = ['Date', 'Time', 'Type', 'Detail', 'Reference', 'Taken by', 'In (£)', 'Out (£)', 'Balance (£)', 'Checked'];
  const lines: string[] = [header.map(csvField).join(',')];
  lines.push(
    [
      londonDate(position.period_start),
      londonTime(position.period_start),
      'Opening balance',
      position.last_signed_count ? 'Counted at the last signed count' : 'No previous count',
      '',
      '',
      '',
      '',
      csvGbp(position.baseline_pence),
      '',
    ]
      .map(csvField)
      .join(','),
  );
  for (const r of rows) {
    lines.push(
      [
        londonDate(r.when),
        londonTime(r.when),
        r.type,
        r.detail,
        r.reference ?? '',
        r.taken_by ?? '',
        r.in_pence > 0 ? csvGbp(r.in_pence) : '',
        r.out_pence > 0 ? csvGbp(r.out_pence) : '',
        csvGbp(r.balance_pence),
        '',
      ]
        .map(csvField)
        .join(','),
    );
  }
  lines.push(
    [
      londonDate(position.period_end),
      londonTime(position.period_end),
      'Expected in safe',
      '',
      '',
      '',
      '',
      '',
      csvGbp(position.expected_in_safe_pence),
      '',
    ]
      .map(csvField)
      .join(','),
  );
  // BOM so Excel opens the £ column correctly; CRLF per RFC 4180.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ── Exports: envelope list ─────────────────────────────────────────────────
//
// Every cash payment goes into the safe in an envelope marked with the
// order number and the customer's name. When the safe is banked the
// envelopes go with the cash, so the envelopes physically in the safe
// should be exactly the recorded cash payments since the last time cash
// was taken out (or since the last count if nothing has been taken out
// since). This list is what the counter matches each envelope against.

export interface EnvelopeListRow {
  payment_id: string;
  order_ref: string | null;
  customer_name: string;
  amount_pence: number;
  taken_at: string;
  taken_by_name: string;
  visit_id: string | null;
}

export function envelopeListSince(position: CashPosition): { since: string; rows: EnvelopeListRow[] } {
  const lastOut = position.lines
    .filter((l) => l.kind === 'withdrawal' && !l.reversed_at)
    .map((l) => l.taken_at)
    .sort()
    .pop();
  const since = lastOut ?? position.period_start;
  const rows = position.lines
    .filter((l): l is CashPositionPaymentLine => l.kind === 'payment' && l.taken_at > since)
    .sort((a, b) => a.taken_at.localeCompare(b.taken_at))
    .map((l) => ({
      payment_id: l.payment_id,
      order_ref: l.appointment_ref,
      customer_name: l.patient_name,
      amount_pence: l.amount_pence,
      taken_at: l.taken_at,
      taken_by_name: l.taken_by_name,
      visit_id: l.visit_id,
    }));
  return { since, rows };
}

export function buildEnvelopeListCsv(position: CashPosition): string {
  const { rows } = envelopeListSince(position);
  const header = ['Order number', 'Customer', 'Amount (£)', 'Date', 'Time', 'Taken by', 'Envelope found'];
  const lines: string[] = [header.map(csvField).join(',')];
  for (const r of rows) {
    lines.push(
      [r.order_ref ?? '', r.customer_name, csvGbp(r.amount_pence), londonDate(r.taken_at), londonTime(r.taken_at), r.taken_by_name, '']
        .map(csvField)
        .join(','),
    );
  }
  lines.push(['Total', '', csvGbp(rows.reduce((s, r) => s + r.amount_pence, 0)), '', '', '', ''].map(csvField).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function downloadTextFile(text: string, filename: string, mime: string): void {
  if (typeof document === 'undefined') {
    throw new Error('downloadTextFile called outside the browser');
  }
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
