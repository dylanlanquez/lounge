#!/bin/zsh
# Clean up shadow after the failed first push.
# Drops the one table that got created (lng_lwo_sequences) and the stale
# schema_migrations row, so the renamed migrations can apply fresh.

set -e
source ~/.zshrc

PSQL="/opt/homebrew/opt/libpq/bin/psql"

echo "Cleaning up shadow's partial migration state..."
"$PSQL" "$LNG_SHADOW_DB_URL" <<'SQL'
DROP TABLE IF EXISTS public.lng_lwo_sequences CASCADE;
DELETE FROM supabase_migrations.schema_migrations WHERE version = '20260428';
SELECT 'cleanup ok' AS status;
SQL

echo ""
echo "CLEANUP COMPLETE"
