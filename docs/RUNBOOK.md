# Runbook

See also **docs/DEPLOYMENT.md** for the minimum free-tier deployment and `scripts/deploy-cloudflare.sh` + `scripts/setup-github-secrets.sh`.

## One-time setup

### 1. Secrets and keys
| Where | Name | Value |
|---|---|---|
| Buffer → Settings → API | – | create an API key → `BUFFER_API_KEY` |
| OpenAI (or Anthropic) | – | `OPENAI_API_KEY` (scoring, copy, Whisper captions) |
| ElevenLabs | – | `ELEVENLABS_API_KEY`, pick the toaster voice → `ELEVENLABS_VOICE_ID` |
| pixabay.com/api/docs | free key | `PIXABAY_API_KEY` (auto-cleared source) |
| pexels.com/api | free key | `PEXELS_API_KEY` (auto-cleared source) |
| Google Cloud console | YouTube Data API v3 | `YOUTUBE_API_KEY` + `ENABLE_YOUTUBE_CC=true` (opt-in, see docs/SOURCES.md) |
| reddit.com/prefs/apps | free "script" app | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`, `REDDIT_USERNAME`, `REDDIT_PASSWORD` — **primary viral source** (transformation review) |
| – | policy | `TRANSFORMATION_REVIEW=true`, `MAX_COPYRIGHT_RISK=medium`; `ENABLE_YOUTUBE_TRANSFORM=true` (default: YouTube virals via yt-dlp, no key needed; `YOUTUBE_VIRAL_WINDOWS=today,week,month,alltime`, `REDDIT_WINDOWS=day,week`) |
| GitHub → Settings → Secrets → Actions | six secrets | see docs/DEPLOYMENT.md (no terminal needed); then Actions → "Deploy control plane (Cloudflare)" → Run workflow |
| Buffer → Settings → Tags (optional) | tags "REVIEW" and "CLEARED" | `BUFFER_TAG_REVIEW_ID`, `BUFFER_TAG_CLEARED_ID` (`toaster buffer:tags` tries to list them) |
| – | credits / voice | `CONTACT_EMAIL` (default theunhingedtoaster@gmail.com), `COMMENTARY_DEFAULT=auto` (LLM decides per clip: voice / text / none) |
| Slack/Discord (optional) | incoming webhook | `ALERT_WEBHOOK_URL` |
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
npm run toaster -- fetch --limit 40     # download + probe scored candidates without rendering (download yield, resolution, audio, length)
npm run toaster -- produce --count 3
npm run toaster -- funnel               # measured funnel discovered -> scored -> eligible -> downloaded -> quality -> rendered, with API cost per video
npm run toaster -- publish --dry-run
npm run toaster -- sync
npm run toaster -- report            # weekly readiness: 21 targets, funnel, shortages, blockers
npm run toaster -- status
```
Without `TOASTER_API_URL` the CLI uses `work/db.json`, so everything can be exercised locally first.

## Testing ladder (cheap first; run before any weekly batch)

GitHub → Actions → "Diagnostics (preflight / smoke / pilot)" → Run workflow. Each rung has its own API budget
(`budget` input, default $2; the run stops with a clear message when it is used up) and per-step time limits.

| rung | what it does | time | cost | creates Buffer posts? |
|---|---|---|---|---|
| `preflight` | configuration + **one real scoring call with the configured model** + Worker reachability and token + Buffer account/channels (read-only) + ElevenLabs voices + Reddit feed; exit 1 with the failing row when something essential is broken | ~1 min | < $0.01 | no |
| `smoke` | 2 feeds → score ≤ 5 → download and render exactly 1 Short → fetch its public URL and check it plays | ~6 min | < $0.20 | no |
| `pilot` | 3 distinct Shorts through the full path; Buffer **drafts** only when `create_drafts` is ticked (owner still approves) | ~15 min | < $0.50 | only if ticked |

The weekly batch and the daily run execute the production preflight first and refuse to start when it fails. Failed LLM
calls never count as scores: such candidates stay `discovered` with an `llm_error` reason and are re-scored next run;
two consecutive 400/401/403 answers from a service stop the run immediately (circuit breaker) instead of repeating the
same error for every candidate. Spend is metered (`API_BUDGET_USD`, production default $15 weekly / $8 daily; set the
repository variable to change it) and reported at the end of every run together with elapsed time.

## Dog-content pilot (opt-in, manual, never publishes)

Paid AI generation is paused (owner decision): `ai_count` and `ai_video_budget` default to 0 and a paid provider refuses
to start at $0. GitHub → Actions → "Dog pilot (opt-in, never publishes)" → Run workflow with `ranking_count=3`: three
real-dog ranking compilations from licensed footage (Wikimedia Commons CC0/PD/CC BY and Internet Archive need no key;
Pexels / Pixabay are added when their free keys exist). The run writes `dog-pilot-report.md`
(per video: format, attempts, rejections, cost per accepted video, quality scores, rights) plus a contact sheet and the
finished mp4s as artifacts. It creates no Buffer posts; the general daily/weekly schedules are untouched.
Rankings use licensed stock only; when fewer than 3 funny licensed clips exist the shortage is reported, not filled.
Sound effects: set repository variable `SFX_PROVIDER=elevenlabs` to build the real library once (10 effects, ~2,000
ElevenLabs credits, inside the free tier); otherwise free placeholders are used and clearly labelled.

### Viral funny-dog shortlist (discovery only)

GitHub → Actions → "Dog shortlist (discovery only, never publishes)" → Run workflow (or `npm run toaster -- dog-shortlist
--top 30 --limit 60`). It scans the YouTube dog hashtag Shorts shelves, verifies every view count through the
embedded-player metadata (≥ 1,000,000 required), looks at three real frames per clip, scores comedy (clear payoff, single
clip, quality, safety), scans TikTok creator pages when handles exist (`TIKTOK_ACCOUNTS` variable, the `tiktok_handles`
input, or handles read from watermarks), lists Reddit dog communities (no view counts there), and writes a ranked
shortlist (title, platform, verified views, URL, comedy score, duration, rights status) to `dog-shortlist.md` /
`dog-shortlist.json` in the run artifact. Cost ≈ $0.003 per scored clip (default budget $2). It stores nothing, creates no
Buffer posts and does not touch the daily/weekly schedules; rights stay exactly as the general policy says (standard
licence = transformation review, owner decides per draft).

## Weekly operation
- Sunday morning: read the readiness report (weekly run summary or `GET <worker>/weeks/next/report?format=md`): it lists which drafts are transformation-review (source, creator, copyright risk) and which have an explicit basis. Then open Buffer → Drafts (review drafts carry the REVIEW tag when configured). Approve ("Add to queue" or "Schedule") or delete. Captions are already public-ready: creator credit, source link, edit summary, contact e-mail.
- Nothing else. A deletion is confirmed after two polls ≥ 10 min apart, then a replacement is rendered and drafted into the same slot (Worker: ~30–60 min; Actions fallback: ~2–4 h). Replacements are new drafts, so they appear in the Drafts tab for your next look.
- Readiness: `GET https://<worker>/weeks/next/report?format=md` (Bearer token), or the step summary of the weekly GitHub Actions run, or `npm run toaster -- report`.
- Alerts: the weekly run fails (red, e-mail from GitHub) and opens/updates a `[toaster] readiness <week>` issue when fewer than 21 videos are drafted; `ALERT_WEBHOOK_URL` additionally posts to Slack/Discord.

## When things go wrong
| Symptom | Cause | Fix |
|---|---|---|
| Buffer "Video could not be read from its URL" | R2 bucket not public / wrong `R2_PUBLIC_BASE_URL` | open the URL in an incognito window; fix public access |
| `blocked_rights` / `rights:unknown` everywhere | only Reddit/YouTube-CC candidates | add Pixabay/Pexels keys, or sign a clip-licensing deal (docs/SOURCES.md) |
| report says `score_below_threshold` for most | stock sources are not viral enough | expected; needs a licensed viral library for 21/week |
| sync shows `not found (1/2, awaiting confirmation)` | first observation of a deleted draft | nothing to do; confirmed on the next poll |
| no captions | clip has no speech | expected; only the commentary box is shown |
| `TTS failed` | ElevenLabs key/quota | video ships without VO; fix key |
| drafts created but never approved → slot passes | nothing is published; the slot is simply skipped | approve earlier or lower the stock |
