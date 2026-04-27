#!/bin/zsh
# Deploys ALL Lounge edge functions to Meridian. Idempotent - re-deploying
# overwrites the existing version. Use after adding a new function or editing
# an existing one.

set -e
source ~/.zshrc

PROJECT_REF="npuvhxakffxqoszytkxw"
cd ~/Desktop/lounge-app

for fn in calendly-webhook calendly-backfill terminal-start-payment terminal-webhook terminal-cancel-payment terminal-refund send-receipt; do
  if [[ -d "supabase/functions/$fn" ]]; then
    echo "[deploy] $fn"
    if [[ "$fn" == "terminal-webhook" || "$fn" == "calendly-webhook" ]]; then
      npx --yes supabase@latest functions deploy "$fn" --project-ref "$PROJECT_REF" --no-verify-jwt
    else
      npx --yes supabase@latest functions deploy "$fn" --project-ref "$PROJECT_REF"
    fi
  else
    echo "[skip] $fn (folder not found)"
  fi
done

echo ""
echo "DONE. Deployed all available edge functions."
