#!/bin/zsh
# Lounge shadow bootstrap. Run once.
# Dumps Meridian schema, restores to shadow.
#
# Uses full paths to libpq tools so PATH issues don't matter.

set -e
source ~/.zshrc

PG_DUMP="/opt/homebrew/opt/libpq/bin/pg_dump"
PSQL="/opt/homebrew/opt/libpq/bin/psql"

if [[ ! -x "$PG_DUMP" ]]; then
  echo "ERROR: $PG_DUMP not found. Run: brew install libpq"
  exit 1
fi

echo "1/4 Dumping Meridian schema..."
"$PG_DUMP" --schema-only --no-owner --no-privileges \
  --schema=public --schema=auth --schema=storage \
  "$LNG_MERIDIAN_DB_URL" > /tmp/meridian-schema.sql

LINES=$(wc -l < /tmp/meridian-schema.sql)
INSERTS=$(grep -c '^INSERT' /tmp/meridian-schema.sql || echo 0)
echo "    Dump OK: $LINES lines, $INSERTS INSERTs (expect 0)"

echo "2/4 Restoring to shadow..."
"$PSQL" "$LNG_SHADOW_DB_URL" < /tmp/meridian-schema.sql > /tmp/restore.log 2>&1
echo "    Restore done"

echo "3/4 Restore tail (last 5 lines of log):"
tail -5 /tmp/restore.log

echo "4/4 Counting tables on shadow..."
SHADOW_TABLES=$("$PSQL" "$LNG_SHADOW_DB_URL" -tA -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';")
echo "    Public tables on shadow: $SHADOW_TABLES"

echo ""
echo "BOOTSTRAP COMPLETE"
