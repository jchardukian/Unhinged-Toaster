# Minimum deployment (free tiers, existing accounts)

Everything runs on: GitHub Actions (compute, free minutes), Cloudflare Workers + D1 + R2 (control plane + public media,
free tier), Buffer (existing Essentials account), OpenAI (pay-as-you-go, cents/week), ElevenLabs (existing account), Reddit
(free script app). No paid licensing, no new paid services.

## Launch checklist in plain language (about 30 minutes, once)

You need a computer with Node.js 22, Git, the GitHub CLI (`gh auth login`) and a Cloudflare account (free).
Nothing below costs money: Buffer, OpenAI (a few cents per week), ElevenLabs free tier, Cloudflare free tier, GitHub Actions.

1. **Copy the settings file**: `cp .env.example .env`, open `.env` in any text editor.
2. **Paste four keys** into `.env`: `BUFFER_API_KEY` (Buffer → Settings → API), `OPENAI_API_KEY` (platform.openai.com → API keys),
   `ELEVENLABS_API_KEY` (elevenlabs.io → profile → API keys), and optionally `YOUTUBE_API_KEY` (Google Cloud console → YouTube Data API v3).
   Never share `.env`; it is ignored by Git and is never uploaded anywhere except, by the next steps, into GitHub's and Cloudflare's secret stores.
3. **Create the control plane**: `scripts/deploy-cloudflare.sh` (a browser window asks you to log in to Cloudflare once).
   It creates the database and media bucket, writes `TOASTER_API_TOKEN` into `.env` (never printed) and prints the Worker URL:
   put that URL into `.env` as `TOASTER_API_URL`.
4. **Hand the keys to GitHub**: `scripts/setup-github-secrets.sh`. It reads `.env` and stores every key as a GitHub Actions secret
   (encrypted, masked in logs). It prints the names of the keys it set, never their values.
5. **Dress the channels**: paste `assets/brand/channel_description.txt` into YouTube Studio and the TikTok profile.
6. **Dry run**: GitHub → Actions → "Weekly batch" → Run workflow with `dry_run=true`. Read the readiness and funnel reports in the run summary.
7. **Real run**: the same workflow without dry run. Every Sunday: open Buffer, approve the drafts you like, delete the ones you do not.
   Deleted drafts are replaced automatically on the next sync; nothing is ever published without your approval.

What the scripts never do: commit secrets (`.env` is git-ignored and the repository contains no key files), print secret values, publish a post,
or buy anything.

## Credentials: what can be wired automatically vs. what needs the owner

| Item | Needed for | Can be configured through an existing integration? | Owner action |
|---|---|---|---|
| GitHub repo + Actions | compute | **Yes** – repo exists, workflows committed, CI green on PR #1 | Merge PR #1 |
| Buffer channel ids / org id / timezone | drafts | **Yes** – read through the connected Buffer integration and baked into `.env.example` / `wrangler.toml` | none |
| Buffer **API key** | pipeline → Buffer | No – personal keys are created in the Buffer UI only | Buffer → Settings → API → create key → `BUFFER_API_KEY` |
| Buffer tags `REVIEW` / `CLEARED` (optional) | visual marker in Buffer | No | Buffer → Settings → Tags → create both, copy ids → `BUFFER_TAG_REVIEW_ID`, `BUFFER_TAG_CLEARED_ID` (the readiness report lists review drafts regardless) |
| OpenAI key | scoring, copy, Whisper | The key injected into this session is session-scoped and cannot be exported | Create a project key → `OPENAI_API_KEY` |
| ElevenLabs key + voice id | commentary voice | Same (session-scoped) | Profile → API keys → `ELEVENLABS_API_KEY`; pick voice → `ELEVENLABS_VOICE_ID` |
| **YouTube Data API key** (free) | viral discovery metadata (duration, date, stats) without YouTube's bot wall | No | Google Cloud console → enable "YouTube Data API v3" → API key → `YOUTUBE_API_KEY` (10 000 units/day; the pipeline uses ~100) |
| **YouTube cookies** (`YTDLP_COOKIES_B64`) | downloading YouTube virals from GitHub-hosted runners (bot-walled otherwise; the CI probe got 0/40) | No | One-time, ~5 min: in a **private** browser window log in to YouTube, export cookies with a "Get cookies.txt LOCALLY" extension, close the window without logging out, then `base64 -w0 cookies.txt` → secret `YTDLP_COOKIES_B64`. Use a secondary Google account: YouTube may flag an account used for automated downloads. Refresh when downloads start failing (every few months). Alternative: a self-hosted runner on a home connection (set `YTDLP_ASSUME_FETCHABLE=true`). Without either, the pipeline skips YouTube and runs on Reddit + fillers. |
| Reddit script app | viral source (feeds work without it, with ~10 req/min rate limits) | No | https://www.reddit.com/prefs/apps → "script" app → `REDDIT_CLIENT_ID/SECRET`, plus the account's `REDDIT_USERNAME/PASSWORD` |
| Cloudflare D1 + R2 + Worker | DB, storage, public media, approval poller | No – needs `wrangler login` in the owner's browser once | run `scripts/deploy-cloudflare.sh` |
| GitHub PAT for the Worker | Worker → `workflow_dispatch` (replacements, weekly kick) | No | fine-grained PAT, repo `Unhinged-Toaster`, Actions: read & write → Worker secret `GITHUB_TOKEN` |
| Channel descriptions | branding | No (Buffer API cannot edit profiles) | paste `assets/brand/channel_description.txt` (see docs/CHANNEL_DESCRIPTION.md) |
| Brand files, licensed music | visuals | No | drop into `assets/brand/`, `assets/music/` |
| Pixabay / Pexels keys (optional fillers) | cleared footage | No | free keys |

## Fastest path (about 30 minutes of owner time)

1. `cp .env.example .env` and fill: `BUFFER_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `YOUTUBE_API_KEY`, `YTDLP_COOKIES_B64` (YouTube virals), optional `REDDIT_*`.
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
