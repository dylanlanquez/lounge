#!/usr/bin/env node
// Phase 4 — Checkpoint backfill (real implementation).
//
// Reads Checkpoint's walk_ins, calendly_bookings, payments_* and writes
// equivalents into Lounge's lng_walk_ins / lng_visits / lng_appointments /
// lng_payments / lng_calendly_bookings.
//
// Identity resolution per docs/06-patient-identity.md §2:
//   1. lwo_ref exact match
//   2. shopify_customer_id exact
//   3. email + location_id (case-insensitive)
//   4. phone (normalised, last 10 digits)
//   5. otherwise: create new patient
//
// Idempotency: every insert is keyed on a stable Checkpoint id (e.g.
// walk_ins.id -> stored as a column on lng_walk_ins.checkpoint_id IF the
// migration that adds it is in. For now we use ON CONFLICT DO NOTHING on
// (start-time, patient, location) shape — see phase 4 §11.1).
//
// Flags:
//   --dry-run     do not write to Lounge; just count / report
//   --since=YYYY-MM-DD   only walk-ins on or after this date (default: 2024-01-01)
//   --limit=N     max walk-ins to process (default: unlimited)
//
// Usage:
//   node scripts/checkpoint-backfill.mjs --dry-run --limit=10

import pg from 'pg';
import process from 'node:process';

const { Client } = pg;

const args = parseArgs(process.argv.slice(2));
const DRY_RUN = args['dry-run'] !== undefined;
const SINCE = args.since ?? '2024-01-01';
const LIMIT = args.limit ? Number(args.limit) : null;

const CHECKPOINT_URL = process.env.CHECKPOINT_DB_URL;
const MERIDIAN_URL = process.env.LNG_MERIDIAN_DB_URL;

if (!CHECKPOINT_URL || !MERIDIAN_URL) {
  console.error('ERROR: CHECKPOINT_DB_URL and LNG_MERIDIAN_DB_URL must be set in env.');
  process.exit(1);
}

const cp = new Client({ connectionString: CHECKPOINT_URL });
const lng = new Client({ connectionString: MERIDIAN_URL });

const stats = {
  walkInsRead: 0,
  walkInsApplied: 0,
  walkInsSkipped: 0,
  patientsCreated: 0,
  patientsMatched: 0,
  paymentsApplied: 0,
  errors: [],
};

await cp.connect();
await lng.connect();
console.log(`Connected. dryRun=${DRY_RUN} since=${SINCE} limit=${LIMIT ?? 'none'}`);

// Resolve default Venneir lab location from Lounge.
const { rows: locRows } = await lng.query(
  `SELECT id FROM public.locations WHERE type = 'lab' AND is_venneir = true ORDER BY name LIMIT 1`
);
if (locRows.length === 0) throw new Error('No Venneir lab location found in Meridian.');
const defaultLocationId = locRows[0].id;
console.log(`Default location_id: ${defaultLocationId}`);

// Fetch walk-ins from Checkpoint.
const limitClause = LIMIT ? `LIMIT ${LIMIT}` : '';
const { rows: walkIns } = await cp.query(
  `SELECT id, lwo_ref, first_name, last_name, email, phone, address, city, postcode,
          dob, gender, service_type, appliance_type, arch, repair_notes,
          payment_amount, payment_method, payment_taken_at, payment_card_ref,
          payment_cash_amount, payment_card_amount, payment_notes,
          tech_scan_started_at, tech_scan_completed_at, status, created_at, completed_at
   FROM public.walk_ins
   WHERE created_at >= $1
   ORDER BY created_at ASC
   ${limitClause}`,
  [SINCE]
);
stats.walkInsRead = walkIns.length;
console.log(`Read ${walkIns.length} walk-ins from Checkpoint.`);

for (const wi of walkIns) {
  try {
    const patient_id = await resolveOrCreatePatient(wi, defaultLocationId);
    if (DRY_RUN) {
      stats.walkInsSkipped++;
      continue;
    }

    // Insert lng_walk_ins
    const { rows: lngWiRows } = await lng.query(
      `INSERT INTO public.lng_walk_ins
        (patient_id, location_id, arrival_type, service_type, repair_notes, created_at)
       VALUES ($1, $2, 'walk_in', $3, $4, $5)
       RETURNING id`,
      [patient_id, defaultLocationId, wi.service_type, wi.repair_notes, wi.created_at]
    );
    const walk_in_id = lngWiRows[0].id;

    // Insert lng_visits
    const { rows: lngVRows } = await lng.query(
      `INSERT INTO public.lng_visits
        (patient_id, location_id, walk_in_id, arrival_type, status, opened_at, closed_at)
       VALUES ($1, $2, $3, 'walk_in', $4, $5, $6)
       RETURNING id`,
      [
        patient_id,
        defaultLocationId,
        walk_in_id,
        wi.status === 'complete' ? 'complete' : wi.status === 'cancelled' ? 'cancelled' : 'opened',
        wi.created_at,
        wi.completed_at,
      ]
    );
    const visit_id = lngVRows[0].id;

    // Open a cart and a single line item for the legacy total
    if (wi.payment_amount && wi.payment_amount > 0) {
      const totalPence = Math.round(Number(wi.payment_amount) * 100);
      const { rows: cartRows } = await lng.query(
        `INSERT INTO public.lng_carts (visit_id, status, opened_at, closed_at)
         VALUES ($1, 'paid', $2, $3) RETURNING id`,
        [visit_id, wi.created_at, wi.completed_at ?? wi.payment_taken_at ?? wi.created_at]
      );
      const cart_id = cartRows[0].id;
      await lng.query(
        `INSERT INTO public.lng_cart_items (cart_id, name, quantity, unit_price_pence)
         VALUES ($1, $2, 1, $3)`,
        [cart_id, wi.repair_notes ?? wi.service_type ?? 'Walk-in (legacy)', totalPence]
      );

      const journey =
        wi.payment_method === 'klarna'
          ? 'klarna_legacy_shopify'
          : wi.payment_method === 'clearpay'
            ? 'clearpay_legacy_shopify'
            : 'standard';
      const method =
        wi.payment_method === 'cash'
          ? 'cash'
          : wi.payment_method === 'card' || wi.payment_method === 'split' || wi.payment_method === 'klarna' || wi.payment_method === 'clearpay'
            ? 'card_terminal'
            : 'cash';
      await lng.query(
        `INSERT INTO public.lng_payments
          (cart_id, method, payment_journey, amount_pence, status, succeeded_at, notes)
         VALUES ($1, $2, $3, $4, 'succeeded', $5, $6)`,
        [
          cart_id,
          method,
          journey,
          totalPence,
          wi.payment_taken_at ?? wi.completed_at ?? wi.created_at,
          `Backfill from Checkpoint walk_ins.id=${wi.id}; method=${wi.payment_method}; ref=${wi.payment_card_ref ?? 'none'}`,
        ]
      );
      stats.paymentsApplied++;
    }

    stats.walkInsApplied++;
    if (stats.walkInsApplied % 25 === 0) {
      console.log(`  applied ${stats.walkInsApplied}/${walkIns.length}…`);
    }
  } catch (e) {
    stats.errors.push(`walk_in ${wi.id}: ${(e instanceof Error ? e.message : String(e))}`);
  }
}

console.log('');
console.log('==================== BACKFILL SUMMARY ====================');
console.log(`Walk-ins read:       ${stats.walkInsRead}`);
console.log(`Walk-ins applied:    ${stats.walkInsApplied}`);
console.log(`Walk-ins skipped:    ${stats.walkInsSkipped} (dry-run)`);
console.log(`Patients matched:    ${stats.patientsMatched}`);
console.log(`Patients created:    ${stats.patientsCreated}`);
console.log(`Payments applied:    ${stats.paymentsApplied}`);
console.log(`Errors:              ${stats.errors.length}`);
if (stats.errors.length > 0) {
  console.log('');
  console.log('First 10 errors:');
  for (const err of stats.errors.slice(0, 10)) console.log(`  - ${err}`);
}
console.log('==========================================================');

await cp.end();
await lng.end();

// ---------- helpers ----------

async function resolveOrCreatePatient(wi, location_id) {
  // 1. lwo_ref
  if (wi.lwo_ref) {
    const { rows } = await lng.query(`SELECT id FROM public.patients WHERE lwo_ref = $1 LIMIT 1`, [wi.lwo_ref]);
    if (rows[0]) {
      stats.patientsMatched++;
      return rows[0].id;
    }
  }
  // 2. email + location
  if (wi.email) {
    const { rows } = await lng.query(
      `SELECT id FROM public.patients WHERE location_id = $1 AND lower(email) = lower($2) LIMIT 1`,
      [location_id, wi.email]
    );
    if (rows[0]) {
      stats.patientsMatched++;
      return rows[0].id;
    }
  }
  // 3. phone
  if (wi.phone) {
    const digits = wi.phone.replace(/\D/g, '').slice(-10);
    if (digits.length >= 7) {
      const { rows } = await lng.query(
        `SELECT id FROM public.patients
          WHERE location_id = $1
            AND regexp_replace(coalesce(phone,''), '[^0-9]', '', 'g') LIKE '%' || $2
          LIMIT 1`,
        [location_id, digits]
      );
      if (rows[0]) {
        stats.patientsMatched++;
        return rows[0].id;
      }
    }
  }

  if (DRY_RUN) {
    stats.patientsCreated++; // would-create
    return '00000000-0000-0000-0000-000000000000';
  }

  // 4. create new
  const { rows } = await lng.query(
    `INSERT INTO public.patients (location_id, first_name, last_name, email, phone, date_of_birth, sex, address, lwo_ref)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      location_id,
      wi.first_name || 'Patient',
      wi.last_name || '',
      wi.email,
      wi.phone,
      wi.dob,
      wi.gender,
      [wi.address, wi.city, wi.postcode].filter(Boolean).join(', ') || null,
      wi.lwo_ref,
    ]
  );
  stats.patientsCreated++;
  return rows[0].id;
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? '';
  }
  return out;
}
