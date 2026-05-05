#!/bin/zsh
# Phase 4 - Checkpoint backfill (skeleton).
#
# Mirrors Checkpoint's walk_ins / calendly_bookings / payments_* into Lounge's
# lng_* tables. Resolves each Checkpoint customer to a Meridian patient via
# §6.1 priority order (lwo_ref -> shopify_customer_id -> email+location_id ->
# phone -> name+DOB), creating new patients only when no match exists.
#
# Status: SKELETON. Real implementation depends on Checkpoint Supabase
# read access. This script documents the steps and emits empty SQL for
# review. Run real backfill from a Node script with both connection
# strings; see Phase 4 §11.1 of the brief.

set -e

if [[ -z "$LNG_MERIDIAN_DB_URL" ]]; then
  echo "ERROR: LNG_MERIDIAN_DB_URL not set"
  exit 1
fi
if [[ -z "$CHECKPOINT_DB_URL" ]]; then
  echo "ERROR: CHECKPOINT_DB_URL not set."
  echo "  Add to ~/.zshrc:"
  echo "    export CHECKPOINT_DB_URL='postgresql://postgres.emonsrrhflmwfsuupibj:<pw>@aws-1-<region>.pooler.supabase.com:5432/postgres'"
  echo "  (Direct db.<ref>.supabase.co hostnames are now IPv6-only — use the session pooler URL from the Supabase dashboard.)"
  echo "  Then source ~/.zshrc and re-run."
  exit 1
fi

PSQL="/opt/homebrew/opt/libpq/bin/pg_dump"
echo "Backfill plan (no destructive writes performed yet):"
echo ""
echo "  1. Export Checkpoint walk_ins, calendly_bookings, payments_* via pg_dump --data-only"
echo "  2. For each walk-in:"
echo "     a. Resolve patient_id in Meridian via §6.1 priority"
echo "     b. INSERT lng_walk_ins, lng_visits referencing the resolved patient"
echo "     c. For each linked payment row, INSERT into lng_payments with"
echo "        payment_journey IN ('klarna_legacy_shopify', 'clearpay_legacy_shopify',"
echo "        'standard') depending on source method"
echo "  3. For each calendly_booking with a linked walk-in:"
echo "     INSERT lng_appointments + lng_calendly_bookings (source=calendly_legacy)"
echo "  4. Reconciliation report: row counts on each side; differences"
echo ""
echo "When ready:"
echo "  - Implement scripts/checkpoint-backfill.mjs with both connection strings"
echo "  - Run on staging Lounge first, verify against 50 hand-picked rows"
echo "  - Then production"

# Placeholder verification: confirm we can reach both DBs.
echo ""
echo "[connectivity] Meridian:"
psql "$LNG_MERIDIAN_DB_URL" -c "SELECT 'meridian ok' AS status, count(*) AS lng_visits FROM public.lng_visits;" 2>&1 | tail -3 || echo "  Meridian unreachable"
echo "[connectivity] Checkpoint:"
psql "$CHECKPOINT_DB_URL" -c "SELECT 'checkpoint ok' AS status, count(*) AS walk_ins FROM public.walk_ins;" 2>&1 | tail -3 || echo "  Checkpoint unreachable. Set CHECKPOINT_DB_URL and re-run."
