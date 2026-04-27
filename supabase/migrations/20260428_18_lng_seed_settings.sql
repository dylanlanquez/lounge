-- 20260428_18_lng_seed_settings.sql
-- Seed global default rows in lng_settings.
--
-- BNPL scripts use placeholder content with TODO markers. Final content lives in
-- ~/Desktop/lounge-app/bnpl-staff-guide/ — Dylan to update these rows from Supabase
-- Studio once the staff guide is dropped in.
--
-- Per `01-architecture-decision.md §3.6` and brief §5.6.
--
-- Rollback: DELETE FROM public.lng_settings WHERE location_id IS NULL AND key LIKE 'bnpl.%';
--           DELETE FROM public.lng_settings WHERE location_id IS NULL AND key LIKE 'epos.%';

insert into public.lng_settings (key, value, description) values

-- BNPL — Klarna
('bnpl.klarna.preflight',
 '"Does the customer already have the Klarna app, with Apple Pay or Google Pay set up on their phone?"'::jsonb,
 'BNPL pre-flight question (Klarna). Yes → proceed; No → walk through download.'),

('bnpl.klarna.steps',
 '[
   {"id":1,"text":"TODO: replace with Step 1 from bnpl-staff-guide/"},
   {"id":2,"text":"TODO: replace with Step 2 from bnpl-staff-guide/"},
   {"id":3,"text":"TODO: replace with Step 3 from bnpl-staff-guide/"},
   {"id":4,"text":"TODO: replace with Step 4 from bnpl-staff-guide/"}
 ]'::jsonb,
 'Customer-facing steps the receptionist walks through (Klarna). Lifted verbatim from staff guide.'),

('bnpl.klarna.troubleshoot',
 '[
   {"row":"declined tap","says":"Don''t keep retapping. Ask the customer to reopen the app and check the pre-auth amount or card limit."},
   {"row":"not eligible","says":"Klarna decided this. The helper does not say approved or denied; relay only what the customer''s app says."},
   {"row":"no app","says":"Offer card or cash instead. Do not advise on whether to use BNPL."},
   {"row":"venneir not in klarna list","says":"TODO: replace from staff guide."}
 ]'::jsonb,
 'Troubleshooting matrix shown inside helper (Klarna).'),

('bnpl.klarna.faq',
 '[
   {"q":"Why not Shopify?","a":"TODO from staff guide."},
   {"q":"Why not the website?","a":"TODO from staff guide."},
   {"q":"Will it affect my credit?","a":"Pointer: their Klarna app explains this."},
   {"q":"Why does the receipt say Visa?","a":"That''s Klarna''s virtual Visa card; the instalment plan is in the Klarna app."}
 ]'::jsonb,
 '"If the customer asks" panel content (Klarna).'),

-- BNPL — Clearpay
('bnpl.clearpay.preflight',
 '"Does the customer already have the Clearpay app, with Apple Pay or Google Pay set up on their phone?"'::jsonb,
 'BNPL pre-flight question (Clearpay).'),

('bnpl.clearpay.steps',
 '[
   {"id":1,"text":"TODO: replace from staff guide"},
   {"id":2,"text":"TODO: replace from staff guide"},
   {"id":3,"text":"TODO: replace from staff guide"},
   {"id":4,"text":"TODO: replace from staff guide"}
 ]'::jsonb,
 'Customer-facing steps (Clearpay).'),

('bnpl.clearpay.troubleshoot',
 '[
   {"row":"declined tap","says":"TODO from staff guide."},
   {"row":"not eligible","says":"TODO from staff guide."},
   {"row":"no app","says":"Offer card or cash instead."},
   {"row":"venneir not in clearpay list","says":"TODO from staff guide."}
 ]'::jsonb,
 'Troubleshooting matrix (Clearpay).'),

('bnpl.clearpay.faq',
 '[
   {"q":"Why not Shopify?","a":"TODO from staff guide."},
   {"q":"Will it affect my credit?","a":"Pointer: their Clearpay app explains this."}
 ]'::jsonb,
 '"If the customer asks" panel content (Clearpay).'),

-- Shared "what I can''t say" rules
('bnpl.never_say',
 '[
   "Don''t promise approval — Klarna or Clearpay decide.",
   "Don''t quote interest, fees, or repayment terms.",
   "Don''t advise on whether to use BNPL.",
   "Don''t suggest setting card limit higher than the sale needs."
 ]'::jsonb,
 'Hard rules. Always visible at bottom of BNPLHelper.'),

-- EPOS defaults
('epos.currency',         '"GBP"'::jsonb,                                                       'Display currency.'),
('epos.tax_rate_basis',   '"item_inclusive"'::jsonb,                                            'Tax mode. item_inclusive = unit_price already includes VAT; tax line on receipt is for display only.'),
('epos.receipt_default_channel', '"email"'::jsonb,                                              'Default receipt channel selector value.'),
('epos.idle_lock_seconds', '60'::jsonb,                                                         'Tablet auto-lock after N seconds of inactivity. Brief §7.2.');
