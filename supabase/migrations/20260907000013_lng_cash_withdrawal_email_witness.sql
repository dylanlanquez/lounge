-- 20260907000013_lng_cash_withdrawal_email_witness.sql
--
-- Two-person rule, email side. The cash_withdrawal_notification template
-- gains a "Witnessed by" block so the managers' email records who was
-- present. Applied to both the live copy and the default copy, and only
-- when the block is not already there, so a hand-edited template is
-- extended rather than overwritten. The send-manager-notification
-- function supplies {{witnessName}} (deployed alongside this migration).

update public.lng_email_templates
   set body_syntax = replace(
         body_syntax,
         E'**Taken by**\n{{takenByName}}',
         E'**Taken by**\n{{takenByName}}\n\n**Witnessed by**\n{{witnessName}}'
       ),
       default_body_syntax = replace(
         default_body_syntax,
         E'**Taken by**\n{{takenByName}}',
         E'**Taken by**\n{{takenByName}}\n\n**Witnessed by**\n{{witnessName}}'
       ),
       updated_at = now()
 where key = 'cash_withdrawal_notification'
   and body_syntax not like '%witnessName%';
