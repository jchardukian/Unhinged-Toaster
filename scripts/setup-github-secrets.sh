#!/usr/bin/env bash
# One-shot: push every key from .env into GitHub Actions secrets/variables for jchardukian/Unhinged-Toaster.
# Requires: gh CLI logged in (gh auth login) with repo admin. Run from the repo root after filling .env.
set -euo pipefail
REPO="${REPO:-jchardukian/Unhinged-Toaster}"
ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE (copy .env.example and fill it in)"; exit 1; }

SECRETS="OPENAI_API_KEY ANTHROPIC_API_KEY ELEVENLABS_API_KEY BUFFER_API_KEY YOUTUBE_API_KEY REDDIT_CLIENT_ID REDDIT_CLIENT_SECRET REDDIT_USERNAME REDDIT_PASSWORD PEXELS_API_KEY PIXABAY_API_KEY R2_ACCOUNT_ID R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY TOASTER_API_TOKEN ALERT_WEBHOOK_URL"
VARS="LLM_PROVIDER LLM_MODEL ELEVENLABS_VOICE_ID REDDIT_USER_AGENT R2_BUCKET R2_PUBLIC_BASE_URL TOASTER_API_URL BUFFER_TIMEZONE PUBLISH_SLOTS BUFFER_APPROVAL_MODE BUFFER_TAG_REVIEW_ID BUFFER_TAG_CLEARED_ID CONTACT_EMAIL COMMENTARY_DEFAULT ENABLE_YOUTUBE_CC ENABLE_YOUTUBE_TRANSFORM TRANSFORMATION_REVIEW MAX_COPYRIGHT_RISK DISCOVERY_SOURCES BUFFER_SYNC_VIA_ACTIONS"

get() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | sed -e 's/[[:space:]]*#.*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" | xargs || true; }

for k in $SECRETS; do
  v="$(get "$k")"
  if [ -n "$v" ]; then printf '%s' "$v" | gh secret set "$k" --repo "$REPO" && echo "secret  $k"; else echo "skip    $k (empty)"; fi
done
for k in $VARS; do
  v="$(get "$k")"
  if [ -n "$v" ]; then gh variable set "$k" --repo "$REPO" --body "$v" >/dev/null && echo "var     $k=$v"; else echo "skip    $k (empty)"; fi
done
echo "done. Trigger: gh workflow run weekly-batch.yml --repo $REPO -f dry_run=true"
