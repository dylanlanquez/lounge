-- 20260517000021_lng_refund_receipt_settlement_note.sql
--
-- The refund_receipt template's body hardcoded "Card refunds usually
-- appear within 5 to 10 working days, depending on your bank." That
-- line is correct for card refunds but reads as nonsense for cash
-- (the patient walks out with the money in hand).
--
-- Replace the hardcoded sentence with a {{settlementNote}}
-- placeholder. The send-refund-receipt edge function passes a
-- method-appropriate value:
--
--   • Card / Stripe deposit → "Card refunds usually appear within
--                              5 to 10 working days, depending on
--                              your bank."
--   • Cash                  → "The refund has been handed back to
--                              you at the till — no bank delay."
--   • Other                 → empty string (no settlement line).

update public.lng_email_templates
   set body_syntax = replace(
         body_syntax,
         E'Card refunds usually appear within 5 to 10 working days, depending on your bank.',
         '{{settlementNote}}'
       ),
       default_body_syntax = replace(
         default_body_syntax,
         E'Card refunds usually appear within 5 to 10 working days, depending on your bank.',
         '{{settlementNote}}'
       ),
       version = version + 1
 where key = 'refund_receipt'
   and service_type is null;
