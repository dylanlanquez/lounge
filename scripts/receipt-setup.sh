#!/bin/zsh
# Receipt delivery slice 13b setup (one-time per environment).
#
# Configures Resend (email) and Twilio (SMS) credentials for the
# `send-receipt` edge function.
#
# Prereqs:
#   - $RESEND_API_KEY in your shell env (re...) — required for email receipts
#   - $RESEND_FROM_EMAIL  (defaults to receipts@venneir.com if unset)
#   - $TWILIO_ACCOUNT_SID, $TWILIO_AUTH_TOKEN, $TWILIO_FROM_NUMBER — required for SMS
#
# Email-only is fine: omit the TWILIO_* vars and SMS receipts will fail
# gracefully with `delivery_not_configured` until you add them later.

set -e
source ~/.zshrc

PROJECT_REF="npuvhxakffxqoszytkxw"

if [[ -z "$RESEND_API_KEY" && -z "$TWILIO_ACCOUNT_SID" ]]; then
  echo "ERROR: at least one of RESEND_API_KEY or TWILIO_ACCOUNT_SID must be set."
  echo "       Email-only is the typical setup; SMS is optional."
  exit 1
fi

echo "[1/2] Storing receipt provider secrets in Supabase…"
SECRETS=()
[[ -n "$RESEND_API_KEY"     ]] && SECRETS+=("RESEND_API_KEY=$RESEND_API_KEY")
[[ -n "$RESEND_FROM_EMAIL"  ]] && SECRETS+=("RESEND_FROM_EMAIL=$RESEND_FROM_EMAIL")
[[ -n "$TWILIO_ACCOUNT_SID" ]] && SECRETS+=("TWILIO_ACCOUNT_SID=$TWILIO_ACCOUNT_SID")
[[ -n "$TWILIO_AUTH_TOKEN"  ]] && SECRETS+=("TWILIO_AUTH_TOKEN=$TWILIO_AUTH_TOKEN")
[[ -n "$TWILIO_FROM_NUMBER" ]] && SECRETS+=("TWILIO_FROM_NUMBER=$TWILIO_FROM_NUMBER")

npx --yes supabase@latest secrets set --project-ref $PROJECT_REF "${SECRETS[@]}"

echo "[2/2] Deploying send-receipt edge function…"
cd ~/Desktop/lounge-app
npx --yes supabase@latest functions deploy send-receipt --project-ref $PROJECT_REF

echo ""
echo "DONE."
echo ""
[[ -n "$RESEND_API_KEY"     ]] && echo "Email: ENABLED  from=${RESEND_FROM_EMAIL:-receipts@venneir.com}"
[[ -z "$RESEND_API_KEY"     ]] && echo "Email: DISABLED (set RESEND_API_KEY to enable)"
[[ -n "$TWILIO_ACCOUNT_SID" ]] && echo "SMS:   ENABLED  from=$TWILIO_FROM_NUMBER"
[[ -z "$TWILIO_ACCOUNT_SID" ]] && echo "SMS:   DISABLED (set TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER to enable)"
