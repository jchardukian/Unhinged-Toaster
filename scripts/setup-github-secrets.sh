#!/usr/bin/env bash
# One-shot: copy the keys in .env into GitHub Actions secrets (encrypted) and non-secret settings into Actions variables.
# Requires the GitHub CLI logged in with access to the repository:  gh auth login
# Usage:  scripts/setup-github-secrets.sh [--dry-run] [path/to/.env]
# Prints only the NAMES of what it sets, never the values. Idempotent: re-running overwrites with the current .env.
set -euo pipefail
REPO="${REPO:-jchardukian/Unhinged-Toaster}"
DRY=0
ENV_FILE=".env"
for a in "$@"; do case "$a" in --dry-run) DRY=1 ;; *) ENV_FILE="$a" ;; esac; done
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE (copy .env.example, fill it in, run scripts/deploy-cloudflare.sh first)"; exit 1; }

# Secrets: anything that grants access. Variables: plain settings that are safe to show in the Actions UI.
SECRETS="OPENAI_API_KEY ANTHROPIC_API_KEY ELEVENLABS_API_KEY BUFFER_API_KEY YOUTUBE_API_KEY REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USERNAME REDDIT_PASSWORD PEXELS_API_KEY PIXABAY_API_KEY R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY TOASTER_API_TOKEN ALERT_WEBHOOK_URL"
VARS="LLM_PROVIDER LLM_MODEL VISION_OCR_MODEL ELEVENLABS_VOICE_ID REDDIT_USER_AGENT REDDIT_WINDOWS R2_BUCKET R2_PUBLIC_BASE_URL TOASTER_API_URL BUFFER_TIMEZONE PUBLISH_SLOTS BUFFER_APPROVAL_MODE BUFFER_TAG_REVIEW_ID BUFFER_TAG_CLEARED_ID CONTACT_EMAIL COMMENTARY_DEFAULT MUSIC_DEFAULT STICKERS ENABLE_YOUTUBE_CC ENABLE_YOUTUBE_TRANSFORM YOUTUBE_VIRAL_WINDOWS TRANSFORMATION_REVIEW MAX_COPYRIGHT_RISK DISCOVERY_SOURCES BUFFER_SYNC_VIA_ACTIONS"
# Never sent to GitHub: WORKER_GITHUB_TOKEN (Cloudflare only), YTDLP_COOKIES_B64 (not approved for launch).
REQUIRED="OPENAI_API_KEY ELEVENLABS_API_KEY BUFFER_API_KEY TOASTER_API_TOKEN TOASTER_API_URL"

get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" | xargs 2>/dev/null || true; }

missing=""
for k in $REQUIRED; do [ -n "$(get "$k")" ] || missing="$missing $k"; done
if [ -n "$missing" ]; then
  echo "These required settings are empty in $ENV_FILE:$missing"
  echo "OPENAI_API_KEY / ELEVENLABS_API_KEY / BUFFER_API_KEY: paste the keys. TOASTER_API_TOKEN / TOASTER_API_URL: run scripts/deploy-cloudflare.sh first."
  exit 1
fi

if [ "$DRY" = 1 ]; then
  echo "dry run: nothing is sent to GitHub"
else
  gh auth status >/dev/null 2>&1 || { echo "GitHub CLI is not logged in: run  gh auth login  (choose GitHub.com, HTTPS, log in via browser) and re-run."; exit 1; }
fi

set_secret() { if [ "$DRY" = 1 ]; then echo "secret  $1 (would set)"; else printf '%s' "$2" | gh secret set "$1" --repo "$REPO" >/dev/null && echo "secret  $1"; fi; }
set_var() { if [ "$DRY" = 1 ]; then echo "var     $1 (would set)"; else gh variable set "$1" --repo "$REPO" --body "$2" >/dev/null && echo "var     $1"; fi; }

for k in $SECRETS; do v="$(get "$k")"; if [ -n "$v" ]; then set_secret "$k" "$v"; else echo "skip    $k (empty)"; fi; done
for k in $VARS; do v="$(get "$k")"; if [ -n "$v" ]; then set_var "$k" "$v"; else echo "skip    $k (empty)"; fi; done
echo "done. Next: GitHub → Actions → 'Weekly batch' → Run workflow (dry_run=true first)."
