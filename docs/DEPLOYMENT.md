# Minimum deployment (free tiers, existing accounts)

Everything runs on: GitHub Actions (compute, free minutes), Cloudflare Workers + D1 + R2 (control plane + public media,
free tier), Buffer (existing Essentials account), OpenAI (pay-as-you-go, cents/week), ElevenLabs (existing account), Reddit
(free script app). No paid licensing, no new paid services.

## Credentials: what can be wired automatically vs. what needs the owner

| Item | Needed for | Can be configured through an existing integration? | Owner action |
|---|---|---|---|
| GitHub repo + Actions | compute | **Yes** – repo exists, workflows committed, CI green on PR #1 | Merge PR #1 |
| Buffer channel ids / org id / timezone | drafts | **Yes** – read through the connected Buffer integration and baked into `.env.example` / `wrangler.toml` | none |
| Buffer **API key** | pipeline → Buffer | No – personal keys are created in the Buffer UI only | Buffer → Settings → API → create key → `BUFFER_API_KEY` |
| Buffer tags `REVIEW` / `CLEARED` (optional) | visual marker in Buffer | No | Buffer → Settings → Tags → create both, copy ids → `BUFFER_TAG_REVIEW_ID`, `BUFFER_TAG_CLEARED_ID` (the readiness report lists review drafts regardless) |
| OpenAI key | scoring, copy, Whisper | The key injected into this session is session-scoped and cannot be exported | Create a project key → `OPENAI_API_KEY` |
| ElevenLabs key + voice id | commentary voice | Same (session-scoped) | Profile → API keys → `ELEVENLABS_API_KEY`; pick voice → `ELEVENLABS_VOICE_ID` |
| Reddit script app | primary viral source | No | https://www.reddit.com/prefs/apps → "script" app → `REDDIT_CLIENT_ID/SECRET`, plus the account's `REDDIT_USERNAME/PASSWORD` |
| Cloudflare D1 + R2 + Worker | DB, storage, public media, approval poller | No – needs `wrangler login` in the owner's browser once | run `scripts/deploy-cloudflare.sh` |
| GitHub PAT for the Worker | Worker → `workflow_dispatch` (replacements, weekly kick) | No | fine-grained PAT, repo `Unhinged-Toaster`, Actions: read & write → Worker secret `GITHUB_TOKEN` |
| Channel descriptions | branding | No (Buffer API cannot edit profiles) | paste `assets/brand/channel_description.txt` (see docs/CHANNEL_DESCRIPTION.md) |
| Brand files, licensed music | visuals | No | drop into `assets/brand/`, `assets/music/` |
| Pixabay / Pexels keys (optional fillers) | cleared footage | No | free keys |

## Fastest path (about 30 minutes of owner time)

1. `cp .env.example .env` and fill: `BUFFER_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `REDDIT_*`.
2. `scripts/deploy-cloudflare.sh` (creates D1, R2, applies migrations 0001–0003, sets `API_TOKEN`, deploys; prints
   `TOASTER_API_URL` and `TOASTER_API_TOKEN`). Put both into `.env`. R2 S3 keys are **not** required: the pipeline
   uploads through the Worker (`PUT /upload/<key>`) and Buffer fetches from `<TOASTER_API_URL>/media/<key>`.
3. `scripts/setup-github-secrets.sh` (pushes `.env` into Actions secrets/variables with `gh`).
4. Paste the channel description into YouTube Studio and TikTok.
5. `gh workflow run weekly-batch.yml -f dry_run=true` → read the readiness report in the run summary →
   `gh workflow run weekly-batch.yml` for real → review drafts in Buffer on Sunday.

## Without the Worker (even faster, less robust)
Set GitHub variable `BUFFER_SYNC_VIA_ACTIONS=true`; the Actions poller replaces the Worker cron (2-hourly). Public media
still needs R2 (S3 token + public bucket URL) because Actions cannot serve files.

## Costs at 21 videos/week
GitHub Actions ≈ 2–3 h/week (free), Cloudflare free tier, OpenAI < $1/week, ElevenLabs ≈ 2 k characters/week (and less
when the director picks `none`/`text_only`), Buffer existing plan, Reddit free.
