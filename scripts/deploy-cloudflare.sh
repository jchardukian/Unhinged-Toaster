#!/usr/bin/env bash
# One-shot Cloudflare setup for the control plane (free tier): D1 database, R2 bucket, secrets, deploy.
# Requires: npx wrangler login (opens the browser once). Idempotent: re-running is safe.
set -euo pipefail
cd "$(dirname "$0")/../packages/worker"

echo "== D1"
if ! npx wrangler d1 list --json 2>/dev/null | grep -q '"name": "toaster-db"'; then
  npx wrangler d1 create toaster-db
fi
DB_ID="$(npx wrangler d1 list --json | python3 -c 'import sys,json; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="toaster-db"))')"
sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "database_id=$DB_ID"

echo "== R2"
npx wrangler r2 bucket create toaster-media 2>/dev/null || true

echo "== migrations"
npx wrangler d1 migrations apply toaster-db --remote

echo "== secrets (prompted; paste values)"
: "${API_TOKEN:=$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')}"
printf '%s' "$API_TOKEN" | npx wrangler secret put API_TOKEN
echo "TOASTER_API_TOKEN=$API_TOKEN   <- put this into .env / GitHub secrets"
[ -n "${BUFFER_API_KEY:-}" ] && printf '%s' "$BUFFER_API_KEY" | npx wrangler secret put BUFFER_API_KEY || echo "BUFFER_API_KEY not in env: run 'npx wrangler secret put BUFFER_API_KEY' later"
[ -n "${GH_DISPATCH_TOKEN:-}" ] && printf '%s' "$GH_DISPATCH_TOKEN" | npx wrangler secret put GITHUB_TOKEN || echo "GH_DISPATCH_TOKEN not in env: run 'npx wrangler secret put GITHUB_TOKEN' later (fine-grained PAT, Actions: read/write)"

echo "== deploy"
npx wrangler deploy
echo "Set TOASTER_API_URL to the workers.dev URL printed above. Rendered media is served from <TOASTER_API_URL>/media/<key>;"
echo "no R2 S3 token is needed when the pipeline uploads through the Worker."
