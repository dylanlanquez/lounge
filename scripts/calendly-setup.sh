#!/bin/zsh
# Calendly slice 3 setup (one-time).
#
# Prereqs:
#   - $CALENDLY_PAT env var set in your shell (Personal Access Token)
#   - supabase CLI logged in and linked to Meridian
#
# What it does:
#   1. Generates a random webhook signing key
#   2. Stores CALENDLY_PAT and CALENDLY_WEBHOOK_SIGNING_KEY as Supabase secrets
#   3. Deploys calendly-webhook + calendly-backfill edge functions
#   4. Registers a webhook subscription with Calendly pointing at our endpoint
#
# Idempotent: re-running rotates the signing key and re-registers the webhook.

set -e
source ~/.zshrc

PROJECT_REF="npuvhxakffxqoszytkxw"
WEBHOOK_URL="https://${PROJECT_REF}.functions.supabase.co/calendly-webhook"

if [[ -z "$CALENDLY_PAT" ]]; then
  echo "ERROR: CALENDLY_PAT not set. Add to ~/.zshrc and source it."
  exit 1
fi

# 1. Random signing key (32 bytes hex)
SIGNING_KEY=$(openssl rand -hex 32)
echo "Generated signing key (length=${#SIGNING_KEY})"

# 2. Resolve Calendly user/organization URIs
echo "[1/4] Resolving Calendly user…"
ME=$(curl -s -H "Authorization: Bearer $CALENDLY_PAT" https://api.calendly.com/users/me)
USER_URI=$(echo "$ME" | jq -r '.resource.uri')
ORG_URI=$(echo "$ME" | jq -r '.resource.current_organization')
if [[ -z "$USER_URI" || "$USER_URI" == "null" ]]; then
  echo "ERROR: could not resolve Calendly user. Response: $ME"
  exit 1
fi
echo "  user: $USER_URI"
echo "  org:  $ORG_URI"

# 3. Set Supabase secrets
echo "[2/4] Storing secrets in Supabase…"
npx --yes supabase@latest secrets set \
  --project-ref $PROJECT_REF \
  CALENDLY_PAT="$CALENDLY_PAT" \
  CALENDLY_WEBHOOK_SIGNING_KEY="$SIGNING_KEY"

# 4. Deploy edge functions
echo "[3/4] Deploying edge functions…"
cd ~/Desktop/lounge-app
npx --yes supabase@latest functions deploy calendly-webhook --project-ref $PROJECT_REF --no-verify-jwt
npx --yes supabase@latest functions deploy calendly-backfill --project-ref $PROJECT_REF

# 5. Register webhook with Calendly. user-scope is fine for v1.
echo "[4/4] Registering webhook subscription with Calendly…"
RES=$(curl -s -X POST https://api.calendly.com/webhook_subscriptions \
  -H "Authorization: Bearer $CALENDLY_PAT" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg url "$WEBHOOK_URL" \
    --arg user "$USER_URI" \
    --arg org "$ORG_URI" \
    --arg signingKey "$SIGNING_KEY" \
    '{url: $url, events: ["invitee.created", "invitee.canceled"], organization: $org, user: $user, scope: "user", signing_key: $signingKey}')")
echo "$RES" | jq .

echo ""
echo "DONE."
echo ""
echo "Webhook URL:   $WEBHOOK_URL"
echo "Backfill via:  curl -X POST -H \"Authorization: Bearer <user-jwt>\" https://${PROJECT_REF}.functions.supabase.co/calendly-backfill"
