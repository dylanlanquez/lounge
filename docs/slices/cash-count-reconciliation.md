# Slice: cash count reconciliation

**Route:** `/cash-counts` (Count cash sheet, Activity since last count card, past count details)
**Also touched:** Admin → Reports → Cash drawer (since-last-count figure now comes from the same server function)

## Why

On 7 September 2026 the safe held £2,076.16 against a recorded £1,949.00 and nobody could say whether the software or the clinic was wrong. The count sheet took one typed total, showed "£127.16 over", and offered nothing else. Both earlier counts had matched "expected" to the penny with round-hundred totals, which is what a typed-in expected figure looks like, not a physical count.

Investigation showed the software's arithmetic was consistent: £560 counted on 3 July, £560 banked the same evening, then 27 whole-pound cash payments totalling £1,949. The 16p in the surplus cannot come from any recorded payment, so the extra money entered the safe without being recorded (most likely a change float or coins that were not part of the 3 July count).

## What was built

1. **One number, everywhere.** `lng_cash_safe_position()` (SECURITY DEFINER) is now the only place "expected in safe" is computed. The Cash counts page, the count snapshot, and Reports → Cash drawer all call it. It accepts an explicit `p_period_end` so a count stores exactly what the function said at that moment, and returns who took each payment.
2. **Count by note and coin.** The Count cash sheet opens on a denomination grid (pounds on the left, pence on the right, six rows each). Lounge adds it up and stores the breakdown in `lng_cash_count_denominations`. A trigger refuses to sign a count whose breakdown disagrees with its total. "Total only" remains for a bank-bagged float.
3. **Plain-English difference.** Matched, more than expected, or less than expected, with what each means.
4. **Find the difference.** When there is a difference, the sheet runs the checks a bookkeeper would do by hand, on the same data snapshot:
   - Pence test: pence in the difference when every recorded line is whole pounds means unrecorded coins.
   - A card payment (or two or three together) equal to a surplus: paid in cash, logged as card.
   - A visit still owing exactly the surplus: cash taken, never logged.
   - A cash payment (or combination) equal to a shortfall, naming who took it.
   - A round shortfall: banking or petty cash taken without Take from safe.
   - A carried difference from the previous count.
   - A verdict when nothing recorded matches.
5. **Tick-off checklist and exports.** Every recorded cash payment in the period with a checkbox, progress in money and count, and CSV / PDF downloads (running-balance statement with a Checked column; the PDF has tick boxes and blank Counted / Difference lines). The same exports sit on the Activity since last count card, so staff can print the sheet before opening the safe.
6. **Past counts** show how the cash was counted, and the signed PDF includes the breakdown.
7. **Two-person rule.** The safe is only opened by a safe holder (Admin → Staff → "Safe holder", currently Dylan and Jade), in front of the camera, with the safe witness physically present (Admin → Staff → "Safe witness", currently Robert McCrindle). No codes: both sheets require the witness to be picked and two confirmations ticked ("X is here, watching the safe", "The camera is on and pointed at the safe"). The database refuses any count or withdrawal without a valid active witness, a witness different from the actor, and the camera confirmation (`lng_cash_assert_two_person`). Witness and camera are recorded on the count, the withdrawal, the activity card, past counts, the signed PDF, and the managers' withdrawal email.

## Smoke test (plain English)

1. Sign in as someone with **Count cash** permission. Open **Cash counts**.
2. The Right now card shows one figure. Open Admin → Reports → Cash drawer for the same location: the "since last count" figure is identical.
3. On the Activity card, tap **Download CSV**. The file opens with an Opening balance row, one row per movement with a running balance, an Expected in safe row, and a blank Checked column. Tap **Download PDF**: a working sheet with tick boxes and blank Counted / Difference lines.
4. Tap **Count cash now**. The sheet shows Expected in safe, then a Pounds / Pence grid. Type 3 in £20 and 2 in 50p: the line values read £60.00 and £1.00, the column subtotals update, and Counted in safe reads £61.00.
5. The difference panel reads "£X less than expected" in plain English. Below it, **Find the difference** lists clues. **Check each payment against its receipt** shows the count of payments and money still to check; tap **Show the list**, tick two rows, and the progress line updates. CSV and PDF buttons are there too.
6. Enter quantities that exactly equal the expected figure. The panel turns green: "Matches what Lounge expected". Find the difference and the checklist disappear.
7. Enter a total that differs by more than the threshold (£5 by default). The note field label reads "Note (required)" and Sign and save refuses without one.
8. Switch to **Total only**, type a figure, switch back: the grid is used again and the typed figure is ignored.
9. Pick a different manager, sign. The new row appears in Past counts. Open it: **How it was counted** lists the notes and coins entered, and the PDF includes the same block.
10. Sign in as a staff member with Count cash but not View financials. The Right now figure is identical.
11. The Right now card states the rule and names the witness. Open **Take from safe**, enter an amount, and tap **Record withdrawal** without ticking anything: it refuses and says to confirm the witness is here. Tick "Robert McCrindle is here", tap again: it refuses until "The camera is on" is ticked. Tick both: the withdrawal saves, the activity row reads "by Jade Cassidy · witnessed by Robert McCrindle", and the managers' email shows "Witnessed by Robert McCrindle".
12. Repeat with **Count cash now**: the sheet will not sign until both confirmations are ticked. The new Past counts row and its PDF read "Witnessed by Robert McCrindle, on camera".
13. In Admin → Staff, open Karly: "Safe holder" is off. Open Robert McCrindle: "Safe witness" is on and nothing else.

## Automated

- `src/lib/cashReconcile.test.ts`: clue engine on the real 7 September scenario, exact and combination matches in both directions, pence test, carried difference, statement and CSV shape.
- `src/lib/queries/cashCounts.test.ts`: RPC payload shaping (no recomputation, name casing, loud failure on a bad payload) and denomination arithmetic.
- `tests/cash-counts.spec.ts`: route is gated behind staff sign-in.

## Migrations

- `20260907000010_lng_cash_count_denominations.sql`
- `20260907000011_lng_cash_safe_position_v2.sql`
- `20260907000012_lng_cash_two_person_rule.sql` (witness flag, witness columns, enforcement triggers, safe-holder narrowing, Rob's staff row, RPC v3)
- `20260907000013_lng_cash_withdrawal_email_witness.sql` (adds Witnessed by to the withdrawal email; `send-manager-notification` redeployed with `{{witnessName}}`)

All applied to the shadow, dry-run on Meridian inside a rolled-back transaction with a counter's identity, then applied to Meridian.
