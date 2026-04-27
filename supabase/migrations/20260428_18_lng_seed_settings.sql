-- 20260428_18_lng_seed_settings.sql
-- Seed global default rows in lng_settings.
--
-- BNPL scripts lifted verbatim from bnpl-staff-guide/Venneir-Klarna-Clearpay-Staff-Guide.docx
-- (compiled 25 Apr 2026). Editable in Supabase Studio without redeploying.
--
-- Per `01-architecture-decision.md §3.6` and brief §5.6.
--
-- Rollback: DELETE FROM public.lng_settings WHERE location_id IS NULL AND key LIKE 'bnpl.%';
--           DELETE FROM public.lng_settings WHERE location_id IS NULL AND key LIKE 'epos.%';

insert into public.lng_settings (key, value, description) values

-- BNPL — Klarna
('bnpl.klarna.preflight',
 $${"text":"Does the customer already have the Klarna app, with Apple Pay or Google Pay set up on their phone?","yes_label":"Yes, they have it","no_label":"No, they need to download it","no_followup":"They need to download the Klarna app and register first. It takes 2 to 3 minutes including a quick eligibility check the app does itself. If they cannot or will not wait, offer card or cash instead."}$$::jsonb,
 'BNPL pre-flight question (Klarna). Yes proceeds to steps; No shows download guidance with switch-to-card option.'),

('bnpl.klarna.steps',
 $$[
   {"id":1,"text":"Customer opens the Klarna app and taps Wallet, then Pay In-store."},
   {"id":2,"text":"They find Venneir in the store list. If we do not show up, the customer needs to update their app."},
   {"id":3,"text":"They set a card limit at or above the total (£30 minimum, £2,000 maximum), then add to Apple Pay or Google Pay."},
   {"id":4,"text":"They tap their phone on our card terminal. Receipt prints. Done."}
 ]$$::jsonb,
 'Customer-facing steps for Klarna. Lifted verbatim from staff guide. Each step shows a Done button to advance.'),

('bnpl.klarna.troubleshoot',
 $$[
   {"row":"Tap declines on the terminal","says":"Do not keep retapping. Ask the customer to reopen their app and check the pre-auth amount or card limit matches the total. They re-do the in-app step, then tap again."},
   {"row":"Their app says they are not eligible","says":"That is decided by Klarna, not us. Do not argue or ask why. Politely offer another payment method."},
   {"row":"They do not have the app or no Apple Pay or Google Pay","says":"They cannot use BNPL in-store today. Offer card or cash. Do not try to push them through Shopify, that will not work."},
   {"row":"Venneir does not appear in the Klarna app","says":"Ask them to update the Klarna app. If still missing, message Dylan on Twist before continuing."}
 ]$$::jsonb,
 'Troubleshooting matrix shown inside helper (Klarna). Always reachable as collapsible panel.'),

('bnpl.klarna.faq',
 $$[
   {"q":"Why can we not just send me an invoice like before?","a":"Klarna has updated their systems and the invoice route is no longer supported. The new way is actually faster, you just tap your phone."},
   {"q":"Why does this not go through your website?","a":"In-store and online are two different flows. Both let you pay in instalments. The in-store one is quicker because there is no checkout to fill in."},
   {"q":"Will this affect my credit?","a":"I am not allowed to advise on that. The Klarna app explains it inside the help section."},
   {"q":"Why does the receipt say Visa?","a":"The Klarna app creates a virtual Visa card in your phone wallet. It is not a normal Visa, it is the BNPL plan."}
 ]$$::jsonb,
 '"If the customer asks" panel content (Klarna). Always reachable as collapsible panel.'),

-- BNPL — Clearpay
('bnpl.clearpay.preflight',
 $${"text":"Does the customer already have the Clearpay app, with Apple Pay or Google Pay set up on their phone?","yes_label":"Yes, they have it","no_label":"No, they need to download it","no_followup":"They need to download the Clearpay app and register first. It takes 2 to 3 minutes including a quick eligibility check the app does itself. If they cannot or will not wait, offer card or cash instead."}$$::jsonb,
 'BNPL pre-flight question (Clearpay).'),

('bnpl.clearpay.steps',
 $$[
   {"id":1,"text":"Customer opens the Clearpay app and taps the In-store tab at the bottom."},
   {"id":2,"text":"They tap Authorise and pay in-store, and enter the exact total you have told them."},
   {"id":3,"text":"They tap Pay in-store with Apple Pay (or Google Pay or Samsung Pay). Their wallet pops up."},
   {"id":4,"text":"They tap their phone on our card terminal. Receipt prints. Done."}
 ]$$::jsonb,
 'Customer-facing steps for Clearpay. Lifted verbatim from staff guide.'),

('bnpl.clearpay.troubleshoot',
 $$[
   {"row":"Tap declines on the terminal","says":"Do not keep retapping. Ask the customer to reopen their app and check the pre-auth amount or card limit matches the total. They re-do the in-app step, then tap again."},
   {"row":"Their app says they are not eligible","says":"That is decided by Clearpay, not us. Do not argue or ask why. Politely offer another payment method."},
   {"row":"They do not have the app or no Apple Pay or Google Pay","says":"They cannot use BNPL in-store today. Offer card or cash. Do not try to push them through Shopify, that will not work."}
 ]$$::jsonb,
 'Troubleshooting matrix shown inside helper (Clearpay). Three rows; the Klarna-specific "not in store list" row does not apply.'),

('bnpl.clearpay.faq',
 $$[
   {"q":"Why can we not just send me an invoice like before?","a":"Clearpay has updated their systems and the invoice route is no longer supported. The new way is actually faster, you just tap your phone."},
   {"q":"Why does this not go through your website?","a":"In-store and online are two different flows. Both let you pay in instalments. The in-store one is quicker because there is no checkout to fill in."},
   {"q":"Will this affect my credit?","a":"I am not allowed to advise on that. The Clearpay app explains it inside the help section."},
   {"q":"Why does the receipt say Visa?","a":"The Clearpay app creates a virtual Visa card in your phone wallet. It is not a normal Visa, it is the BNPL plan."}
 ]$$::jsonb,
 '"If the customer asks" panel content (Clearpay).'),

-- Shared "what I cannot say" rules
('bnpl.never_say',
 $$[
   "Do not raise a custom Shopify order or send a Shopify invoice. The old method is gone.",
   "Do not promise approval. Eligibility is decided in-app by Klarna or Clearpay.",
   "Do not advise on whether the customer should use BNPL. These are credit products and we are not authorised to give credit advice.",
   "Do not quote interest, late fees or repayment terms. Point them to the in-app help.",
   "Do not encourage the customer to set their Klarna card limit higher than the sale needs."
 ]$$::jsonb,
 'Hard rules. Always visible at the bottom of BNPLHelper as a chip-list.'),

-- Helper outcome copy (success and failure messages)
('bnpl.outcome.success',
 $${"title":"Paid","body":"Receipt will say Visa contactless. That is correct. Both Klarna and Clearpay use a virtual Visa card behind the scenes. The customer''s instalment plan is in their app."}$$::jsonb,
 'Outcome screen copy on successful BNPL payment.'),

('bnpl.outcome.failed',
 $${"title":"Payment did not go through","body":"Pull from the troubleshooting panel. If unsure, message Dylan on Twist before retrying."}$$::jsonb,
 'Outcome screen copy on failed BNPL payment.'),

-- Refunds (BNPL inline note)
('bnpl.refund_inline_note',
 $${"text":"Ask the customer to reopen their Klarna or Clearpay app and tap the same virtual card to receive the refund. Their instalment schedule updates within 5 to 7 days."}$$::jsonb,
 'Inline note shown in the refund modal when original payment had payment_journey IN (klarna, clearpay).'),

-- EPOS defaults
('epos.currency',                 '"GBP"'::jsonb,                  'Display currency.'),
('epos.tax_rate_basis',           '"item_inclusive"'::jsonb,       'Tax mode. item_inclusive: unit_price already includes VAT; tax line on receipt is for display only.'),
('epos.receipt_default_channel',  '"email"'::jsonb,                'Default receipt channel selector value.'),
('epos.idle_lock_seconds',        '60'::jsonb,                     'Tablet auto-lock after N seconds of inactivity. Brief §7.2.'),
('epos.bnpl.minimum_pence',       '3000'::jsonb,                   'Minimum BNPL transaction (Klarna £30). Below this, BNPL pill is disabled in EPOS.'),
('epos.bnpl.klarna_maximum_pence','200000'::jsonb,                 'Klarna in-store max £2,000 per the staff guide. Above this, Klarna option is disabled.');
