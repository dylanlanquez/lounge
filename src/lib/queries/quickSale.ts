import { supabase } from '../supabase.ts';
import type { CatalogueRow } from './catalogue.ts';
import { addCatalogueItemsToCart, type CatalogueAddOptions } from './carts.ts';
import { COUNTER_SALE_EMAIL } from './patients.ts';

// Quick Sale — a retail product sale that reuses the whole payment
// stack (Terminal card, over-the-phone MOTO, cash) by materialising a
// lightweight visit + cart and handing off to the existing Pay screen.
//
// The basket is held in client state as QuickSaleLine[] until the
// operator taps "Take payment"; only then do we write any rows, so an
// abandoned basket leaves nothing behind. The visit is created
// `complete` + `in_person`, with NO lng_appointments marker, which
// keeps the sale off the Schedule and the In-clinic board while still
// surfacing it in the Ledger (via the walk-in arm, labelled "Retail
// sale" from service_type='retail').
//
// This deliberately mirrors the Arrival wizard's staging-then-commit
// sequence (src/routes/Arrival.tsx) so cart pricing — arch tiers,
// volume extras, upgrades — stays identical between the two surfaces.

// One staged line before the sale is materialised. Same shape as the
// Arrival wizard's StagedItem.
export interface QuickSaleLine {
  key: string;
  catalogue: CatalogueRow;
  qty: number;
  options: CatalogueAddOptions;
}

// service_type discriminator stamped on the walk-in so the Ledger can
// tell a retail sale apart from a clinical walk-in. The label is
// resolved by formatCustomerServiceTitleLabel in appointments.ts.
export const QUICK_SALE_SERVICE_TYPE = 'retail';

// Resolve (or lazily create) the shared anonymous "Counter Sale"
// patient for a location. Idempotent and race-safe: the per-location
// email unique index on patients guarantees a single row per location,
// so a colliding insert from a second tablet falls back to re-reading
// the winner's row.
export async function getOrCreateCounterSalePatient(locationId: string): Promise<string> {
  const existing = await findCounterSalePatient(locationId);
  if (existing) return existing;

  // patients.account_id is a legacy NOT NULL column. Resolve from the
  // signed-in user via auth_account_id(), same as NewWalkIn.
  const { data: accountId, error: accErr } = await supabase.rpc('auth_account_id');
  if (accErr || !accountId) {
    throw new Error(
      accErr?.message ??
        'Could not resolve your account for the counter sale customer. Make sure your accounts row is set up in Meridian.',
    );
  }

  const { data: created, error: insErr } = await supabase
    .from('patients')
    .insert({
      account_id: accountId,
      location_id: locationId,
      first_name: 'Counter',
      last_name: 'Sale',
      email: COUNTER_SALE_EMAIL,
      phone: null,
    })
    .select('id')
    .single();

  if (insErr || !created) {
    // 23505: another tablet created the Counter Sale row between our
    // read and our insert. Re-read and use theirs.
    const raced = await findCounterSalePatient(locationId);
    if (raced) return raced;
    throw new Error(insErr?.message ?? 'Could not create the counter sale customer.');
  }
  return (created as { id: string }).id;
}

async function findCounterSalePatient(locationId: string): Promise<string | null> {
  const { data } = await supabase
    .from('patients')
    .select('id')
    .eq('location_id', locationId)
    .eq('email', COUNTER_SALE_EMAIL)
    .maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

// Materialise a Quick Sale into the FK chain and return the visit id so
// the page can route into /visit/:id/pay. `patientId` is the attached
// real customer, or null to ring up against the Counter Sale patient.
//
// Mirrors Arrival's non-atomic insert sequence (supabase-js has no
// client transaction); the failure window is tiny and any orphan is a
// recoverable open cart on a completed visit, surfaced in the Ledger.
export async function createQuickSaleSale(params: {
  locationId: string;
  patientId: string | null;
  lines: QuickSaleLine[];
}): Promise<{ visitId: string }> {
  const { locationId, lines } = params;
  if (lines.length === 0) {
    throw new Error('Add at least one product before taking payment.');
  }

  const { data: accountId } = await supabase.rpc('auth_account_id');
  const patientId = params.patientId ?? (await getOrCreateCounterSalePatient(locationId));

  // 1. Walk-in row — satisfies the lng_visits one-origin constraint
  //    (exactly one of appointment_id / walk_in_id) and is what makes
  //    the sale appear in the Ledger. service_type='retail' is the
  //    discriminator that drives the "Retail sale" label.
  const { data: walkIn, error: walkErr } = await supabase
    .from('lng_walk_ins')
    .insert({
      patient_id: patientId,
      location_id: locationId,
      arrival_type: 'walk_in',
      service_type: QUICK_SALE_SERVICE_TYPE,
    })
    .select('id')
    .single();
  if (walkErr || !walkIn) throw new Error(walkErr?.message ?? 'Could not open the sale.');

  // 2. Visit — created `arrived` (an OPEN sale), not `complete`. It is
  //    flipped to `complete` only when payment clears (see
  //    completeQuickSaleVisit, called from the Pay screen), so an
  //    abandoned/unpaid sale never masquerades as a completed one in the
  //    Ledger. No lng_appointments marker is written, so it stays off the
  //    Schedule; retail sales are filtered out of the In-clinic board by
  //    service_type='retail' (clinicBoard.ts), so the open sale doesn't
  //    show there either. fulfilment_method stays null — a retail sale is
  //    handed over the counter, not clinically fulfilled.
  const { data: visit, error: visitErr } = await supabase
    .from('lng_visits')
    .insert({
      patient_id: patientId,
      location_id: locationId,
      walk_in_id: (walkIn as { id: string }).id,
      arrival_type: 'walk_in',
      status: 'arrived',
      fulfilment_method: null,
      receptionist_id: (accountId as string | null) ?? null,
    })
    .select('id')
    .single();
  if (visitErr || !visit) throw new Error(visitErr?.message ?? 'Could not open the sale.');
  const visitId = (visit as { id: string }).id;

  // 3. Cart + lines. Reuses addCatalogueItemsToCart so the receipt math
  //    matches the staged subtotal exactly.
  const { data: cart, error: cartErr } = await supabase
    .from('lng_carts')
    .insert({ visit_id: visitId })
    .select('id')
    .single();
  if (cartErr || !cart) throw new Error(cartErr?.message ?? 'Could not open the cart.');
  const cartId = (cart as { id: string }).id;

  for (const line of lines) {
    await addCatalogueItemsToCart(cartId, line.catalogue, line.qty, line.options);
  }

  return { visitId };
}

// Flip a retail sale's visit to `complete` once payment has cleared.
// Called from the Pay screen the moment the visit's paid status becomes
// 'paid'. Minimal by design: the payment already sealed the cart to
// 'paid', a retail sale has no job box or fulfilment step, and the
// "Sale completed" timeline line is intentionally suppressed for retail
// — so all that's needed is the status + close stamp.
export async function completeQuickSaleVisit(visitId: string): Promise<void> {
  const { error } = await supabase
    .from('lng_visits')
    .update({ status: 'complete', closed_at: new Date().toISOString() })
    .eq('id', visitId)
    .neq('status', 'complete');
  if (error) throw new Error(error.message);
}
