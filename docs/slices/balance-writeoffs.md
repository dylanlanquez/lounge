# Slice: balance write-offs

Forgive an uncollectable outstanding balance on a part-paid sale, keep an
audited record, close the sale off the in-clinic board, and allow it to be
reinstated if the patient comes back.

## What it is

A write-off is not a payment and not a refund. The money already collected
stays real (revenue reporting is untouched). A separate, reversible marker
records the forgiven amount and flips the sale to a distinct `written_off`
paid status so it stops reading as owed.

- Table `lng_balance_writeoffs` (audit + reversal columns).
- View `lng_visit_paid_status` gains `written_off_pence` and a `written_off`
  status. `amount_paid_pence` still means real collected money.
- RPCs `lng_write_off_balance` / `lng_reinstate_written_off_balance`, both
  gated on `auth_can_write_off()` (super admin, or the `can_write_off`
  grant on `lng_staff_members`). Acts alone, fully audited, reversible.
- UI: an admin-gated "Write off remaining" action on the Pay screen; an
  Admin, Write-offs tab that lists every write-off and reinstates a live
  one; a `can_write_off` grant in Admin, Staff, Section access.

## Smoke test (plain English)

1. As the super admin, open a sale that is part paid (some money collected,
   a balance still due). On the Pay screen, below the payment methods, a
   "Write off remaining £X" action shows. A cashier without the grant does
   not see it.
2. Tap it, pick a reason, type a note, confirm. The sale closes: it drops
   off the in-clinic board, the visit reads complete, and the balance no
   longer shows as owed. It reads "Written off" on the sale.
3. The collected total is unchanged. Financials and cash counts do not move
   (a write-off is never money in).
4. Open Admin, Write-offs. The write-off is listed with patient, LAP ref,
   amount, who, when, and why, marked Live.
5. Tap Reinstate, type a reason, confirm. The balance reopens: the sale goes
   back on the board, the visit reads arrived, and the amount is due again
   so staff can take payment.
6. A staff member granted "Write off balances" in Admin, Staff can do steps
   1 to 3. Revoking the grant removes the action.

## Notes

- Closing as `complete` (not `ended_early`) is deliberate: the resume /
  reverse visit flow only handles unsuitable / ended_early, so a written-off
  sale never collides with it. Cart lines are preserved so the sale value
  survives for reporting and reinstatement.
- First live use: LAP-00568 (Ben Jones), £229.60 written off on 2026-07-07,
  reason uncontactable.
