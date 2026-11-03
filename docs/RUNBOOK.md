# Runbook

## One-time setup

### 1. Secrets and keys
| Where | Name | Value |
|---|---|---|
| Buffer → Settings → API | – | create an API key → `BUFFER_API_KEY` |
| OpenAI (or Anthropic) | – | `OPENAI_API_KEY` (scoring, copy, Whisper captions) |
| ElevenLabs | – | `ELEVENLABS_API_KEY`, pick the toaster voice → `ELEVENLABS_VOICE_ID` |
| Google Cloud console | YouTube Data API v3 | `YOUTUBE_API_KEY` (CC BY discovery) |
| reddit.com/prefs/apps | "script" app | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` |
| Cloudflare | R2 API token (Object Read & Write) | `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` |

### 2. Cloudflare
```bash
cd packages/worker
npx wrangler login
npx wrangler d1 create toaster-db            # paste database_id into wrangler.toml
npx wrangler r2 bucket create toaster-media
# make the bucket public: Cloudflare dashboard → R2 → toaster-media → Settings → Public access
#   (custom domain, e.g. media.unhingedtoaster.com, or enable r2.dev) → R2_PUBLIC_BASE_URL
npx wrangler d1 migrations apply toaster-db --remote
npx wrangler secret put API_TOKEN            # any long random string -> TOASTER_API_TOKEN in GitHub
npx wrangler secret put BUFFER_API_KEY
npx wrangler secret put GITHUB_TOKEN         # fine-grained PAT, repo jchardukian/Unhinged-Toaster, Actions: read/write
npx wrangler deploy                          # -> https://toaster-api.<account>.workers.dev = TOASTER_API_URL
```

### 3. GitHub → Settings → Secrets and variables → Actions
Secrets: everything in the table above plus `TOASTER_API_TOKEN`.
Variables: `TOASTER_API_URL`, `R2_BUCKET=toaster-media`, `R2_PUBLIC_BASE_URL`, `BUFFER_TIMEZONE=America/Chicago`,
`PUBLISH_SLOTS=11:00,15:00,19:00`, `BUFFER_APPROVAL_MODE=draft`, `ELEVENLABS_VOICE_ID`, `LLM_PROVIDER=openai`, `LLM_MODEL=gpt-4o-mini`.
Set `BUFFER_SYNC_VIA_ACTIONS=true` only while the Worker is not deployed.

### 4. Brand files
Drop the approved files into `assets/brand/` (see `assets/brand/README.md`) and commit.

### 5. Buffer posting schedule (optional)
Drafts carry their own `dueAt`, so Buffer's per-channel posting schedule is not used by the pipeline.
If you prefer "Add to queue" to land on the same times, set both channels to 11:00 / 15:00 / 19:00 in Buffer.

## Local commands
```bash
npm ci && npm run build
cp .env.example .env            # fill in keys
npm run toaster -- doctor
npm run toaster -- demo         # synthetic end-to-end render -> work/demo/demo_final.mp4
npm run toaster -- discover --sources youtube,reddit
npm run toaster -- score
npm run toaster -- rights:outreach --top 10
npm run toaster -- rights:grant <id> --basis written_permission --evidence https://reddit.com/message/...
npm run toaster -- produce --count 3
npm run toaster -- publish --dry-run
npm run toaster -- sync
npm run toaster -- status
```
Without `TOASTER_API_URL` the CLI uses `work/db.json`, so everything can be exercised locally first.

## Weekly operation
- Sunday morning: open Buffer → Drafts. 42 drafts (21 per channel) titled with the headline. Approve or delete.
- Nothing else. Rejections are replaced automatically within ~30 minutes (Worker) or 2 hours (Actions fallback).
- `GET https://<worker>/weeks/next` (Bearer token) shows drafted / approved / rejected / open-slot counts.

## When things go wrong
| Symptom | Cause | Fix |
|---|---|---|
| Buffer "Video could not be read from its URL" | R2 bucket not public / wrong `R2_PUBLIC_BASE_URL` | open the URL in an incognito window; fix public access |
| `blocked_rights` everywhere | only Reddit candidates, no permissions granted | run `rights:outreach`, send messages, `rights:grant` |
| no captions | clip has no speech | expected; only the commentary box is shown |
| `TTS failed` | ElevenLabs key/quota | video ships without VO; fix key |
| drafts created but never approved → slot passes | nothing is published; the slot is simply skipped | approve earlier or lower the stock |
