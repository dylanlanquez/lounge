#!/bin/zsh
# Diagnose why Calendly data isn't showing.

set -e
source ~/.zshrc

PSQL="/opt/homebrew/opt/libpq/bin/psql"

echo "=========================================="
echo "1. WEBHOOK SUBSCRIPTION STATE (Calendly side)"
echo "=========================================="
ME_RES=$(curl -s -H "Authorization: Bearer $CALENDLY_PAT" https://api.calendly.com/users/me)
USER_URI=$(echo "$ME_RES" | jq -r '.resource.uri')
ORG_URI=$(echo "$ME_RES" | jq -r '.resource.current_organization')
echo "user: $USER_URI"
SUBS=$(curl -s -H "Authorization: Bearer $CALENDLY_PAT" "https://api.calendly.com/webhook_subscriptions?organization=$ORG_URI&user=$USER_URI&scope=user")
echo "$SUBS" | jq '.collection[] | {state, callback_url, events, created_at}'

echo ""
echo "=========================================="
echo "2. SCHEDULED EVENTS (next 14 days, Calendly side)"
echo "=========================================="
NOW=$(date -u +"%Y-%m-%dT00:00:00.000Z")
END=$(date -u -v+14d +"%Y-%m-%dT00:00:00.000Z" 2>/dev/null || date -u -d "+14 days" +"%Y-%m-%dT00:00:00.000Z")
EVENTS=$(curl -s -H "Authorization: Bearer $CALENDLY_PAT" \
  "https://api.calendly.com/scheduled_events?user=$USER_URI&min_start_time=$NOW&max_start_time=$END&count=20&status=active")
COUNT=$(echo "$EVENTS" | jq '.collection | length')
echo "Active events in next 14 days: $COUNT"
echo "$EVENTS" | jq '.collection[] | {name, start_time, uri}' | head -40

echo ""
echo "=========================================="
echo "3. LOUNGE DB STATE"
echo "=========================================="
"$PSQL" "$LNG_MERIDIAN_DB_URL" <<'SQL'
SELECT 'lng_calendly_bookings rows' AS check, count(*) FROM public.lng_calendly_bookings;
SELECT 'lng_appointments rows (all)' AS check, count(*) FROM public.lng_appointments;
SELECT 'lng_appointments rows (calendly source)' AS check, count(*) FROM public.lng_appointments WHERE source='calendly';
SELECT 'recent calendly-webhook failures (1h)' AS check, count(*) FROM public.lng_system_failures WHERE source='calendly-webhook' AND occurred_at > now() - interval '1 hour';

SELECT 'last 5 webhook deliveries' AS section;
SELECT delivery_id, event, processed_at IS NOT NULL AS processed, failure_reason
  FROM public.lng_calendly_bookings ORDER BY created_at DESC LIMIT 5;

SELECT 'last 5 calendly-webhook failures' AS section;
SELECT occurred_at, severity, message FROM public.lng_system_failures
  WHERE source='calendly-webhook' ORDER BY occurred_at DESC LIMIT 5;

SELECT 'venneir lab locations' AS section;
SELECT id, name, type, is_venneir FROM public.locations WHERE is_venneir = true ORDER BY name;
SQL
echo ""
echo "DONE."
