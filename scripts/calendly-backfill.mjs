#!/usr/bin/env node
// Calendly backfill (local). Pulls scheduled_events from the Calendly API
// using $CALENDLY_PAT, then writes lng_calendly_bookings + lng_appointments
// directly via $LNG_MERIDIAN_DB_URL. Bypasses the calendly-backfill edge
// function (which needs a user JWT we don't have here).
//
// Usage:
//   node scripts/calendly-backfill.mjs                      # default: today + 60 days forward
//   node scripts/calendly-backfill.mjs --days-back=30 --days-ahead=90
//   node scripts/calendly-backfill.mjs --dry-run

import pg from 'pg';

const args = parseArgs(process.argv.slice(2));
const DRY = args['dry-run'] !== undefined;
const DAYS_BACK = Number(args['days-back'] ?? '0');
const DAYS_AHEAD = Number(args['days-ahead'] ?? '60');

const PAT = process.env.CALENDLY_PAT;
const DB_URL = process.env.LNG_MERIDIAN_DB_URL;
if (!PAT || !DB_URL) {
  console.error('ERROR: CALENDLY_PAT and LNG_MERIDIAN_DB_URL must be set');
  process.exit(1);
}

const db = new pg.Client({ connectionString: DB_URL });
await db.connect();
console.log(`Connected to Meridian. dryRun=${DRY} window=-${DAYS_BACK}d..+${DAYS_AHEAD}d`);

// 1. /users/me
const me = await calendly('GET', '/users/me');
const userUri = me.resource?.uri;
if (!userUri) {
  console.error('Could not resolve Calendly user', me);
  process.exit(1);
}
console.log(`Calendly user: ${userUri}`);

// 2. Default location (first Venneir lab)
const { rows: locRows } = await db.query(
  `SELECT id FROM public.locations WHERE type='lab' AND is_venneir=true ORDER BY name LIMIT 1`
);
if (locRows.length === 0) {
  console.error('No Venneir lab location found.');
  process.exit(1);
}
const locationId = locRows[0].id;
console.log(`Default location_id: ${locationId}`);

// 3. Fetch all scheduled events in the window
const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000).toISOString();
const until = new Date(Date.now() + DAYS_AHEAD * 24 * 60 * 60 * 1000).toISOString();
const events = [];
let pageToken = null;
for (let i = 0; i < 50; i++) {
  const url = new URL('https://api.calendly.com/scheduled_events');
  url.searchParams.set('user', userUri);
  url.searchParams.set('min_start_time', since);
  url.searchParams.set('max_start_time', until);
  url.searchParams.set('count', '100');
  url.searchParams.set('status', 'active');
  if (pageToken) url.searchParams.set('page_token', pageToken);
  const res = await calendly('GET', url.pathname + url.search);
  const collection = res.collection ?? [];
  events.push(...collection);
  pageToken = res.pagination?.next_page_token ?? null;
  if (!pageToken) break;
}
console.log(`Fetched ${events.length} active events from Calendly.`);

let appliedAppts = 0;
let appliedPatients = 0;
let matchedPatients = 0;
let skipped = 0;
const errors = [];

for (const evt of events) {
  try {
    const eventUuid = evt.uri.split('/').pop();
    const invsRes = await calendly('GET', `/scheduled_events/${eventUuid}/invitees?count=100`);
    const invitees = invsRes.collection ?? [];

    for (const inv of invitees) {
      try {
        const email = inv.email?.toLowerCase().trim();
        const firstName = inv.first_name ?? splitName(inv.name).first ?? 'Patient';
        const lastName = inv.last_name ?? splitName(inv.name).last ?? '';

        // Identity-resolve patient: email + location, then create
        let patientId = null;
        if (email) {
          const r = await db.query(
            `SELECT id FROM public.patients WHERE location_id=$1 AND lower(email)=$2 LIMIT 1`,
            [locationId, email]
          );
          if (r.rows[0]) {
            patientId = r.rows[0].id;
            matchedPatients++;
          }
        }
        if (!patientId) {
          if (DRY) {
            patientId = '00000000-0000-0000-0000-000000000000';
          } else {
            const created = await db.query(
              `INSERT INTO public.patients (location_id, first_name, last_name, email)
               VALUES ($1, $2, $3, $4)
               RETURNING id`,
              [locationId, firstName || 'Patient', lastName, email]
            );
            patientId = created.rows[0].id;
          }
          appliedPatients++;
        }

        if (DRY) {
          appliedAppts++;
          continue;
        }

        // Insert lng_appointments. Conflict on calendly_invitee_uri unique index = skip.
        const ins = await db.query(
          `INSERT INTO public.lng_appointments
            (patient_id, location_id, source, calendly_event_uri, calendly_invitee_uri,
             start_at, end_at, event_type_label, status)
           VALUES ($1, $2, 'calendly', $3, $4, $5, $6, $7, 'booked')
           ON CONFLICT (calendly_invitee_uri) DO NOTHING
           RETURNING id`,
          [patientId, locationId, evt.uri, inv.uri, evt.start_time, evt.end_time, evt.name]
        );
        if (ins.rows.length === 0) {
          skipped++;
        } else {
          appliedAppts++;
          // patient_events
          await db.query(
            `INSERT INTO public.patient_events (patient_id, event_type, payload)
             VALUES ($1, $2, $3)`,
            [
              patientId,
              'appointment_booked',
              { source: 'calendly_backfill', start_at: evt.start_time, calendly_invitee_uri: inv.uri },
            ]
          );
        }
      } catch (e) {
        errors.push(`invitee ${inv.uri}: ${e.message ?? String(e)}`);
      }
    }
  } catch (e) {
    errors.push(`event ${evt.uri}: ${e.message ?? String(e)}`);
  }
}

console.log('');
console.log('==================== BACKFILL SUMMARY ====================');
console.log(`Events fetched:       ${events.length}`);
console.log(`Appointments applied: ${appliedAppts}`);
console.log(`Appointments skipped: ${skipped} (already in lng_appointments)`);
console.log(`Patients matched:     ${matchedPatients}`);
console.log(`Patients created:     ${appliedPatients}`);
console.log(`Errors:               ${errors.length}`);
if (errors.length > 0) {
  console.log('');
  console.log('First 10 errors:');
  errors.slice(0, 10).forEach((e) => console.log(`  - ${e}`));
}
console.log('==========================================================');

await db.end();

// ---------- helpers ----------

async function calendly(method, path, body) {
  const r = await fetch(`https://api.calendly.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${PAT}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = {};
  try { parsed = await r.json(); } catch {}
  if (!r.ok) {
    throw new Error(`Calendly ${method} ${path} failed: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

function splitName(name) {
  if (!name) return { first: '', last: '' };
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) out[m[1]] = m[2] ?? '';
  }
  return out;
}
