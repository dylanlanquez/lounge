#!/bin/zsh
# clear-widget-cache.sh
#
# Forces the customer-facing widget assets to be re-fetched by
# Vercel's edge CDN, so a fresh deploy is visible on the partner
# Shopify pages (venneir.com, denture-services.co.uk) immediately
# instead of waiting up to s-maxage seconds for the edge cache to
# expire.
#
# vercel.json sets `s-maxage=600, stale-while-revalidate=86400` on
# the embed openers + main bundles, so without a forced purge a
# partner page can keep serving the previous build for up to ten
# minutes after `git push`. This script:
#
#   1. Triggers a fresh production deployment via `vercel redeploy`.
#      Vercel invalidates the edge cache scope for the new
#      deployment's URL paths, so /embed/*.js + /widgets/*/main.js
#      pick up the latest hashes.
#   2. Warms the cache by hitting each widget URL with a unique
#      cache-busting query string so the very first user request
#      lands a fresh response rather than triggering the edge fetch
#      itself.
#   3. Prints the x-vercel-cache header for each URL so you can see
#      MISS (fresh) vs HIT (still stale) at a glance.
#
# Usage:
#   ./scripts/clear-widget-cache.sh            → redeploy + warm + verify
#   ./scripts/clear-widget-cache.sh --no-deploy → skip the redeploy, just
#                                                 warm + verify

set -euo pipefail

REDEPLOY=1
if [[ "${1:-}" == "--no-deploy" ]]; then
  REDEPLOY=0
fi

HOST="https://lounge.venneir.com"
URLS=(
  "$HOST/embed/venneir.js"
  "$HOST/embed/denture.js"
  "$HOST/widgets/venneir/main.js"
  "$HOST/widgets/denture/main.js"
)

if [[ $REDEPLOY -eq 1 ]]; then
  echo "→ redeploying production (this rebuilds the widget bundles)"
  npx --yes vercel@latest redeploy "$HOST" --yes >/dev/null 2>&1 || {
    echo "  vercel redeploy didn't run — push an empty commit instead:"
    echo "    git commit --allow-empty -m 'chore: bust widget cache' && git push"
  }
fi

echo
echo "→ warming the CDN with cache-busting requests"
BUST="?cachebust=$(date +%s)"
for url in "${URLS[@]}"; do
  status=$(curl -s -o /dev/null -w "%{http_code}" "$url$BUST")
  cache=$(curl -sI "$url" | grep -i '^x-vercel-cache:' | awk '{print $2}' | tr -d '\r' || echo '?')
  age=$(curl -sI "$url" | grep -i '^age:' | awk '{print $2}' | tr -d '\r' || echo '?')
  printf "  %-55s  HTTP %s  cache=%s  age=%s\n" "$url" "$status" "${cache:-?}" "${age:-?}"
done

echo
echo "→ done. Hard-refresh the partner page (Cmd+Shift+R) once cache=MISS"
echo "  to confirm the new bundle is live."
