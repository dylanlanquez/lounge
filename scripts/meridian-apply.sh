#!/bin/zsh
# Apply Lounge's 18 migrations to Meridian production using direct psql.
# Bypasses the supabase CLI's diff logic (which fails because Meridian's
# date-prefix migrations collide on the schema_migrations PK).
#
# Each migration is applied in its own transaction. Idempotent: skips any
# migration that's already recorded in schema_migrations.
#
# Usage: /tmp/lng-meridian-apply.sh

set -e
source ~/.zshrc

PSQL="/opt/homebrew/opt/libpq/bin/psql"
MIGRATIONS_DIR="/Users/dylan/Desktop/lounge-app/supabase/migrations"

if [[ -z "$LNG_MERIDIAN_DB_URL" ]]; then
  echo "ERROR: LNG_MERIDIAN_DB_URL not set"
  exit 1
fi

APPLIED=0
SKIPPED=0
FAILED=0

for f in "$MIGRATIONS_DIR"/20260428*.sql; do
  base=$(basename "$f")
  version=$(echo "$base" | sed -E 's/^([0-9]+)_.*/\1/')
  name=$(echo "$base" | sed -E 's/^[0-9]+_(.*)\.sql/\1/')

  # Already applied?
  ALREADY=$("$PSQL" "$LNG_MERIDIAN_DB_URL" -tA -c \
    "SELECT count(*) FROM supabase_migrations.schema_migrations WHERE version='$version';" 2>/dev/null || echo 0)
  if [[ "$ALREADY" -gt 0 ]]; then
    echo "[skip]  $version $name (already in schema_migrations)"
    SKIPPED=$((SKIPPED + 1))
    continue
  fi

  echo "[apply] $version $name"
  if "$PSQL" "$LNG_MERIDIAN_DB_URL" -v ON_ERROR_STOP=1 -f "$f" > /tmp/lng-apply-$version.log 2>&1; then
    "$PSQL" "$LNG_MERIDIAN_DB_URL" -c \
      "INSERT INTO supabase_migrations.schema_migrations(version, name) VALUES ('$version', '$name');" > /dev/null
    echo "        applied + recorded"
    APPLIED=$((APPLIED + 1))
  else
    echo "        FAILED. Log: /tmp/lng-apply-$version.log"
    tail -15 /tmp/lng-apply-$version.log
    FAILED=$((FAILED + 1))
    break
  fi
done

echo ""
echo "================================="
echo "Applied: $APPLIED  Skipped: $SKIPPED  Failed: $FAILED"
echo "================================="
if [[ "$FAILED" -gt 0 ]]; then
  echo "Stop and investigate the failed migration before retrying."
  exit 1
fi
