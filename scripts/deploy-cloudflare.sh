#!/usr/bin/env bash
# One-shot Cloudflare setup for the control plane (free tier): D1 database, R2 bucket, Worker secrets, deploy.
#
# What you need before running it: Node.js 22, a Cloudflare account, and a filled-in .env in the repo root
# (copy .env.example). The first run opens a browser window once for `wrangler login`.
#
# Reads from .env (never printed):  BUFFER_API_KEY, WORKER_GITHUB_TOKEN (optional), TOASTER_API_TOKEN (reused if set).
# Writes into .env:                 TOASTER_API_TOKEN (generated once), TOASTER_API_URL (the Worker's URL).
# Idempotent: re-running keeps the existing database, bucket and token.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
WORKER_DIR="$ROOT/packages/worker"
[ -f "$ENV_FILE" ] || { echo "No $ENV_FILE. Run:  cp .env.example .env  and fill in BUFFER_API_KEY first."; exit 1; }

# Read one key from .env without `source` (so nothing in the file is ever executed or echoed).
envget() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" | xargs 2>/dev/null || true; }
# Write or replace one key in .env (value never printed).
envset() {
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
[ -n "$BUFFER_API_KEY" ] || { echo "BUFFER_API_KEY is empty in .env (Buffer → Settings → API). Fill it in and re-run."; exit 1; }

cd "$WORKER_DIR"
command -v npx >/dev/null || { echo "Node.js (npx) not found: install Node.js 22 from nodejs.org and re-run."; exit 1; }
[ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm ci)

echo "== Cloudflare login"
if ! npx wrangler whoami >/dev/null 2>&1; then
  echo "A browser window will open: log in to Cloudflare and come back here."
  npx wrangler login
fi

echo "== D1 database (toaster-db)"
if ! npx wrangler d1 list --json 2>/dev/null | grep -q '"name": "toaster-db"'; then
  npx wrangler d1 create toaster-db >/dev/null
fi
DB_ID="$(npx wrangler d1 list --json | python3 -c 'import sys,json; print(next(d["uuid"] for d in json.load(sys.stdin) if d["name"]=="toaster-db"))')"
sed -i.bak "s/database_id = \".*\"/database_id = \"$DB_ID\"/" wrangler.toml && rm -f wrangler.toml.bak
echo "   database ready"

echo "== R2 bucket (toaster-media)"
npx wrangler r2 bucket create toaster-media >/dev/null 2>&1 || true
echo "   bucket ready"

echo "== Database migrations"
npx wrangler d1 migrations apply toaster-db --remote

echo "== Worker secrets (values are sent to Cloudflare, never shown)"
if [ -z "$API_TOKEN" ]; then
  API_TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  envset TOASTER_API_TOKEN "$API_TOKEN"
  echo "   generated TOASTER_API_TOKEN and saved it into .env"
else
  echo "   reusing TOASTER_API_TOKEN from .env"
fi
printf '%s' "$API_TOKEN" | npx wrangler secret put API_TOKEN >/dev/null
printf '%s' "$BUFFER_API_KEY" | npx wrangler secret put BUFFER_API_KEY >/dev/null
echo "   API_TOKEN, BUFFER_API_KEY set"
if [ -n "$WORKER_GITHUB_TOKEN" ]; then
  printf '%s' "$WORKER_GITHUB_TOKEN" | npx wrangler secret put GITHUB_TOKEN >/dev/null
  echo "   GITHUB_TOKEN set (the Worker can start the weekly batch and replacements by itself)"
else
  echo "   WORKER_GITHUB_TOKEN not in .env: skipped. Optional; without it you start 'Weekly batch' from the GitHub Actions page each week."
fi

echo "== Deploy"
DEPLOY_OUT="$(npx wrangler deploy 2>&1 | tee /dev/stderr)"
URL="$(printf '%s\n' "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)"
if [ -n "$URL" ]; then
  envset TOASTER_API_URL "$URL"
  echo "== Done. TOASTER_API_URL=$URL saved into .env. Next: scripts/setup-github-secrets.sh"
else
  echo "== Deployed, but the Worker URL was not found in the output above: copy the https://…workers.dev URL into .env as TOASTER_API_URL."
fi
