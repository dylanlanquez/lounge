# Slice: cash count reconciliation

**Route:** `/cash-counts` (Count cash sheet, Activity since last count card, past count details)
**Also touched:** Admin → Reports → Cash drawer (since-last-count figure now comes from the same server function)

## Why

On 7 September 2026 the safe held £2,076.16 against a recorded £1,949.00 and nobody could say whether the software or the clinic was wrong. The count sheet took one typed total, showed "£127.16 over", and offered nothing else. Both earlier counts had matched "expected" to the penny with round-hundred totals, which is what a typed-in expected figure looks like, not a physical count.

Investigation showed the software's arithmetic was consistent: £560 counted on 3 July, £560 banked the same evening, then 27 whole-pound cash payments totalling £1,949. The 16p in the surplus cannot come from any recorded payment, so the extra money entered the safe without being recorded (most likely a change float or coins that were not part of the 3 July count).

## What was built

1. **One number, everywhere.** `lng_cash_safe_position()` (SECURITY DEFINER) is now the only place "expected in safe" is computed. The Cash counts page, the count snapshot, and Reports → Cash drawer all call it. It accepts an explicit `p_period_end` so a count stores exactly what the function said at that moment, and returns who took each payment.
2. **One total.** The Count cash sheet asks for the counted total and nothing else. (A note-and-coin grid was tried and removed on Dylan's review; the table was dropped in `20260907000014`.)
3. **Plain-English difference.** Matched, more than expected, or less than expected, with what each means.
4. **Extra cash: the envelope log.** Every cash payment goes into the safe in an envelope marked with the order number and the customer's name. When there is more cash than expected the sheet says so and gives three steps: take every envelope out, download the envelope list (recorded cash payments since cash was last taken out), tick each one off, and log every leftover envelope (order number, customer name, amount inside, employee who processed it). The envelopes are saved on the count in `lng_cash_count_unrecorded` and shown in the count's details and PDF for Dylan to review. The difference panel turns green once the envelopes account for all of the extra; a note is required only for what is still unexplained above the threshold.
5. **Find the difference.** When the count is short, the sheet runs the checks a bookkeeper would do by hand, on the same data snapshot (for a surplus only the strong leads are shown under the envelope log):
   - Pence test: pence in the difference when every recorded line is whole pounds means unrecorded coins.
   - A card payment (or two or three together) equal to a surplus: paid in cash, logged as card.
   - A visit still owing exactly the surplus: cash taken, never logged.
   - A cash payment (or combination) equal to a shortfall, naming who took it.
   - A round shortfall: banking or petty cash taken without Take from safe.
   - A carried difference from the previous count.
   - A verdict when nothing recorded matches.
6. **Tick-off list and exports.** Every recorded cash payment (one envelope each) with a checkbox, progress in money and count, and CSV / PDF downloads (running-balance statement with a Checked column; the PDF has tick boxes and blank Counted / Difference lines). The same exports sit on the Activity since last count card.
7. **Two-person rule, no manager step.** The safe is only opened by a safe holder (Admin → Staff → "Safe holder", currently Dylan and Jade), in front of the camera, with the safe witness physically present (Admin → Staff → "Safe witness", currently Robert McCrindle). No codes: both sheets require the witness to be picked and two confirmations ticked ("X is here, watching the safe", "The camera is on and pointed at the safe"). The witness signs the count as the second person; there is no separate manager sign-off. The database refuses any count or withdrawal without a valid active witness, a witness different from the actor, and the camera confirmation (`lng_cash_assert_two_person`). Witness and camera are recorded on the count, the withdrawal, the activity card, past counts, the signed PDF, and the managers' withdrawal email.
8. **Corrections, super admin only.** A withdrawal recorded by mistake is reversed, never deleted: a reason is required, the row is stamped with who reversed it and when, and the event lands in `lng_event_log`. Reversed in the open period, Right now goes back up by the amount. Reversed inside a period already closed by a signed count, Right now stays (it starts from what was physically counted) and that count's expected figure is restated by the amount, so its difference shrinks: on 7 Sep 2026 reversing "WHW supplies" took the count from £686.10 expected (£105.13 over) to £774.60 expected (£16.63 over). The reversal sheet shows a "What changes" table with the exact before and after figures for both cases. A count signed by mistake can be voided the same way: it shows as Voided, Lounge re-anchors on the previous count, and everything since flows back into the open period. Both are `SECURITY DEFINER` functions gated on `auth_is_super_admin()`.
9. **Write off the difference, super admin only.** Once the envelopes and reversals are done, a count that is still a few pounds over or short can be settled with a note: expected becomes the counted total, the count reads as matched with a "Written off" tag, and the original difference, who, when, and why stay on the row, its details, and the PDF. Right now is unaffected (`lng_cash_write_off_difference`).
10. **Date on Take from safe.** The sheet asks when the cash left. Today keeps the exact time; an earlier day is stamped midday. The database refuses a future date or one before the last signed count.
10. **Who sees the page.** The Cash counts page and its wallet icon are shown only to safe holders and to "Safe viewer" (Admin → Staff, currently Stephen Vazquez, read-only). Financials access no longer opens it; Reports → Cash drawer still shows the figure to finance viewers.

## Smoke test (plain English)

1. Sign in as someone with **Count cash** permission. Open **Cash counts**.
2. The Right now card shows one figure. Open Admin → Reports → Cash drawer for the same location: the "since last count" figure is identical.
3. On the Activity card, tap **Download CSV**. The file opens with an Opening balance row, one row per movement with a running balance, an Expected in safe row, and a blank Checked column. Tap **Download PDF**: a working sheet with tick boxes and blank Counted / Difference lines.
4. Tap **Count cash now**. The sheet shows Expected in safe and one field, Counted in safe. Type a figure £50 above expected.
5. The panel reads "£50.00 more than expected". **Log where the extra came from** gives the three envelope steps and a **Download envelope list** button (CSV of order number, customer, amount, taken by, with a blank Envelope found column). Tap **Log an envelope**, enter an order number, a customer name, £50, and pick the employee: the panel turns green, "all accounted for", and the note is optional.
6. Type a figure below expected: **Find the difference** lists clues and **Tick off each envelope** shows the list with progress in money.
7. Type the expected figure exactly: "Matches what Lounge expected".
8. Sign and save refuses until the witness and camera confirmations are ticked. There is no manager picker.
9. Sign. The new row in Past counts reads "Counted by Jade Cassidy · Witnessed by Robert McCrindle, on camera". Open it: **Envelopes not recorded in Lounge** lists what was logged; the PDF includes the same block.
10. Sign in as a staff member with Count cash but not View financials. The Right now figure is identical.
11. The Right now card states the rule and names the witness. Open **Take from safe**, enter an amount, and tap **Record withdrawal** without ticking anything: it refuses and says to confirm the witness is here. Tick "Robert McCrindle is here", tap again: it refuses until "The camera is on" is ticked. Tick both: the withdrawal saves, the activity row reads "by Jade Cassidy · witnessed by Robert McCrindle", and the managers' email shows "Witnessed by Robert McCrindle".
12. Sign in as Hajar or Omar Farouk (Financials, not safe): the wallet icon is absent and /cash-counts redirects home. Sign in as Stephen Vazquez: the page opens, read-only, with no Count or Take buttons.
13. In Admin → Staff, open Karly: "Safe holder" is off. Open Robert McCrindle: "Safe witness" is on and nothing else. Open Stephen Vazquez: "Safe viewer" is on.
14. As Dylan, the activity card shows a **Reverse** pill on each live withdrawal. Tap one, give a reason, confirm: the row turns grey and struck through with "reversed by Dylan Lane: reason", and the Right now figure goes back up. As Jade, no Reverse pill appears and the database refuses the call.
15. Open a past count as Dylan: each withdrawal has Reverse, and the footer has **Void this count**. Reverse one: it is struck through with "reversed after this count" and the balance does not change. Void the count: it shows Voided in Past counts and the Right now card's "Last count" moves back to the previous one.
16. Take from safe: "Date the cash left" defaults to today; pick an earlier day after the last count and the withdrawal appears on that day in the activity. Picking a day before the last count is not possible in the picker, and typing one is refused.

## Automated

- `src/lib/cashReconcile.test.ts`: clue engine on the real 7 September scenario, exact and combination matches in both directions, pence test, carried difference, statement and CSV shape.
- `src/lib/queries/cashCounts.test.ts`: RPC payload shaping (no recomputation, name casing, witness, loud failure on a bad payload).
- `src/lib/cashReconcile.test.ts` also covers the envelope list (since the last time cash was taken out) and its CSV.
- `tests/cash-counts.spec.ts`: route is gated behind staff sign-in.

## Migrations

- `20260907000010_lng_cash_count_denominations.sql`
- `20260907000011_lng_cash_safe_position_v2.sql`
- `20260907000012_lng_cash_two_person_rule.sql` (witness flag, witness columns, enforcement triggers, safe-holder narrowing, Rob's staff row, RPC v3)
- `20260907000013_lng_cash_withdrawal_email_witness.sql` (adds Witnessed by to the withdrawal email; `send-manager-notification` redeployed with `{{witnessName}}`)
- `20260907000014_lng_cash_safe_viewer_and_total_only.sql` (Safe viewer flag and read access, drops the denomination table, `lng_cash_count_unrecorded` envelope log)
- `20260907000015_lng_cash_reversals_and_backdating.sql` (withdrawal reversal columns and `lng_cash_reverse_withdrawal`, `lng_cash_void_count`, backdating guard, RPC skips reversed withdrawals)
- `20260907000016_lng_cash_reversal_restates_count.sql` (a closed-period reversal restates the count's expected; backfilled the WHW reversal)
- `20260907000017_lng_cash_write_off_difference.sql` (write-off columns and `lng_cash_write_off_difference`)

All applied to the shadow, dry-run on Meridian inside a rolled-back transaction with a counter's identity, then applied to Meridian.
