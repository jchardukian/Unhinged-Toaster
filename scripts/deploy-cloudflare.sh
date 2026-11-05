#!/usr/bin/env bash
# Cloudflare control plane setup (free tier): D1 database, R2 bucket, migrations, Worker secrets, deploy.
#
# Two ways to run it, same code path:
#   A) GitHub Actions ("Deploy control plane" workflow, recommended, no terminal): secrets come from the environment
#      (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BUFFER_API_KEY, TOASTER_API_TOKEN, optional WORKER_GITHUB_TOKEN).
#   B) Owner's computer: values are read from .env in the repo root (never `source`d), `wrangler login` opens a browser
#      once, and TOASTER_API_TOKEN / TOASTER_API_URL are written back into .env.
# Idempotent: re-running keeps the existing database, bucket and token. Prints no secret values.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
WORKER_DIR="$ROOT/packages/worker"
WRANGLER="${WRANGLER:-npx wrangler}"   # overridable so the flow can be tested with a fake wrangler

# Value of a key: environment first, then .env (parsed, not executed).
envget() {
  local v="${!1:-}"
  if [ -z "$v" ] && [ -f "$ENV_FILE" ]; then
    v="$(grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" | xargs 2>/dev/null || true)"
  fi
  printf '%s' "$v"
}
# Write or replace one key in .env when .env exists (value never printed).
envset() {
  [ -f "$ENV_FILE" ] || return 0
  python3 - "$ENV_FILE" "$1" "$2" <<'PY'
import re, sys
path, key, value = sys.argv[1:4]
text = open(path, encoding='utf8').read()
line = f"{key}={value}"
if re.search(rf'^{re.escape(key)}=', text, re.M): text = re.sub(rf'^{re.escape(key)}=.*$', line, text, flags=re.M)
else: text = text.rstrip('\n') + '\n' + line + '\n'
open(path, 'w', encoding='utf8').write(text)
PY
}

BUFFER_API_KEY="$(envget BUFFER_API_KEY)"
WORKER_GITHUB_TOKEN="$(envget WORKER_GITHUB_TOKEN)"
API_TOKEN="$(envget TOASTER_API_TOKEN)"
export CLOUDFLARE_API_TOKEN="$(envget CLOUDFLARE_API_TOKEN)"
export CLOUDFLARE_ACCOUNT_ID="$(envget CLOUDFLARE_ACCOUNT_ID)"
CI_MODE=0; [ -n "$CLOUDFLARE_API_TOKEN" ] && CI_MODE=1

if [ "$CI_MODE" = 0 ] && [ ! -f "$ENV_FILE" ]; then
  echo "No .env and no CLOUDFLARE_API_TOKEN. Either run the 'Deploy control plane' GitHub workflow (recommended) or  cp .env.example .env  and fill it in."; exit 1
fi
[ -n "$BUFFER_API_KEY" ] || { echo "BUFFER_API_KEY is missing (Buffer → Settings → API). Add it as a GitHub secret (or in .env) and re-run."; exit 1; }
if [ "$CI_MODE" = 1 ]; then
  [ -n "$CLOUDFLARE_ACCOUNT_ID" ] || { echo "CLOUDFLARE_ACCOUNT_ID is missing (Cloudflare dashboard → Workers & Pages → Account ID on the right). Add it as a GitHub secret and re-run."; exit 1; }
  [ -n "$API_TOKEN" ] || { echo "TOASTER_API_TOKEN is missing: add a GitHub secret with any long random text (40+ characters) and re-run."; exit 1; }
fi

cd "$WORKER_DIR"
if [ "$WRANGLER" = "npx wrangler" ]; then
  command -v npx >/dev/null || { echo "Node.js (npx) not found: install Node.js 22 from nodejs.org and re-run."; exit 1; }
  [ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm ci)
fi

echo "== Cloudflare login"
if ! $WRANGLER whoami >/dev/null 2>&1; then
  if [ "$CI_MODE" = 1 ]; then echo "The Cloudflare API token was rejected. Create it with: Account → Workers Scripts: Edit, D1: Edit, Workers R2 Storage: Edit, Account Settings: Read; User → User Details: Read."; exit 1; fi
  echo "A browser window will open: log in to Cloudflare and come back here."
  $WRANGLER login
fi

echo "== D1 database (toaster-db)"
if ! $WRANGLER d1 list --json 2>/dev/null | grep -q '"name": "toaster-db"'; then
  $WRANGLER d1 create toaster-db >/dev/null
fi
DB_ID="$($WRANGLER d1 list --json | python3 -c 'import sys,json; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="toaster-db"))')"
sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "   database ready"

echo "== R2 bucket (toaster-media)"
$WRANGLER r2 bucket create toaster-media >/dev/null 2>&1 || true
echo "   bucket ready"

echo "== Database migrations"
$WRANGLER d1 migrations apply toaster-db --remote

echo "== Worker secrets (values are sent to Cloudflare, never shown)"
if [ -z "$API_TOKEN" ]; then
  API_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  envset TOASTER_API_TOKEN "$API_TOKEN"
  echo "   generated TOASTER_API_TOKEN and saved it into .env"
else
  echo "   using the existing TOASTER_API_TOKEN"
fi
printf '%s' "$API_TOKEN" | $WRANGLER secret put API_TOKEN >/dev/null
printf '%s' "$BUFFER_API_KEY" | $WRANGLER secret put BUFFER_API_KEY >/dev/null
echo "   API_TOKEN, BUFFER_API_KEY set"
if [ -n "$WORKER_GITHUB_TOKEN" ]; then
  printf '%s' "$WORKER_GITHUB_TOKEN" | $WRANGLER secret put GITHUB_TOKEN >/dev/null
  echo "   GITHUB_TOKEN set (the Worker can start replacement renders by itself)"
else
  echo "   WORKER_GITHUB_TOKEN not set: skipped (optional; replacements then happen on the next daily run)"
fi

echo "== Deploy"
DEPLOY_OUT="$($WRANGLER deploy 2>&1 | tee /dev/stderr)"
URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)"
if [ -n "$URL" ]; then
  envset TOASTER_API_URL "$URL"
  mkdir -p "$ROOT/config" && printf '%s\n' "$URL" > "$ROOT/config/worker-url.txt"
  [ -n "${GITHUB_OUTPUT:-}" ] && echo "worker_url=$URL" >> "$GITHUB_OUTPUT"
  echo "== Done. Worker URL: $URL (saved to config/worker-url.txt$( [ -f "$ENV_FILE" ] && printf ' and .env' ))"
else
  echo "== Deployed, but the Worker URL was not found in the output above: copy the https://…workers.dev URL into config/worker-url.txt."; exit 1
fi
