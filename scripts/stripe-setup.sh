#!/bin/zsh
# Stripe Terminal slice 8/9/10 setup.
#
# Prereqs (in ~/.zshrc):
#   STRIPE_SECRET_KEY=sk_test_... (or sk_live_...)
#   STRIPE_PUBLISHABLE_KEY=pk_test_...
#   STRIPE_EXPECTED_ACCOUNT_ID=acct_...
#
# What it does:
#   1. Stores STRIPE_SECRET_KEY + STRIPE_EXPECTED_ACCOUNT_ID as Supabase secrets
#   2. Deploys terminal-start-payment, terminal-webhook, terminal-cancel-payment
#   3. Generates a webhook signing secret via Stripe API and stores it
#   4. Registers the webhook endpoint with Stripe pointing at terminal-webhook
#
# Idempotent.

set -e
source ~/.zshrc

PROJECT_REF="npuvhxakffxqoszytkxw"
WEBHOOK_URL="https://${PROJECT_REF}.functions.supabase.co/terminal-webhook"

if [[ -z "$STRIPE_SECRET_KEY" ]]; then
  echo "ERROR: STRIPE_SECRET_KEY not set in env"
  exit 1
fi

# 1. Set Supabase secrets
echo "[1/4] Storing Stripe secret + account id in Supabase…"
npx --yes supabase@latest secrets set \
  --project-ref $PROJECT_REF \
  STRIPE_SECRET_KEY="$STRIPE_SECRET_KEY" \
  STRIPE_EXPECTED_ACCOUNT_ID="${STRIPE_EXPECTED_ACCOUNT_ID:-}"

# 2. Deploy edge functions
echo "[2/4] Deploying edge functions…"
cd ~/Desktop/lounge-app
npx --yes supabase@latest functions deploy terminal-start-payment --project-ref $PROJECT_REF
npx --yes supabase@latest functions deploy terminal-webhook --project-ref $PROJECT_REF --no-verify-jwt
npx --yes supabase@latest functions deploy terminal-cancel-payment --project-ref $PROJECT_REF

# 3. Register webhook endpoint with Stripe
echo "[3/4] Registering webhook with Stripe…"
RES=$(curl -s -X POST https://api.stripe.com/v1/webhook_endpoints \
  -u "${STRIPE_SECRET_KEY}:" \
  -d "url=${WEBHOOK_URL}" \
  -d "enabled_events[]=payment_intent.succeeded" \
  -d "enabled_events[]=payment_intent.payment_failed" \
  -d "enabled_events[]=payment_intent.canceled" \
  -d "enabled_events[]=payment_intent.requires_action")
echo "$RES" | jq .
SIGNING_SECRET=$(echo "$RES" | jq -r '.secret')
if [[ -z "$SIGNING_SECRET" || "$SIGNING_SECRET" == "null" ]]; then
  echo "ERROR: could not extract webhook signing secret. Response above."
  exit 1
fi

# 4. Store the webhook signing secret in Supabase
echo "[4/4] Storing webhook signing secret in Supabase…"
npx --yes supabase@latest secrets set --project-ref $PROJECT_REF \
  STRIPE_WEBHOOK_SECRET="$SIGNING_SECRET"

echo ""
echo "DONE."
echo ""
echo "Webhook URL:        $WEBHOOK_URL"
echo "Webhook signing:    stored as STRIPE_WEBHOOK_SECRET in Supabase"
echo ""
echo "Next: in Stripe Dashboard, activate Terminal, create a Location, register"
echo "the S700, then INSERT a row into lng_terminal_readers with friendly_name,"
echo "stripe_reader_id (tmr_…), stripe_location_id (tml_…), location_id."
