# Deployment (Reddit-only launch, free tiers, existing accounts, no terminal)

Everything runs on GitHub Actions (compute), Cloudflare Workers + D1 + R2 (control plane, database, public media; free
tier), Buffer (existing account), OpenAI (pay-as-you-go, under $1/week measured) and ElevenLabs (existing account; the
free tier covers the weekly narration). No paid licensing, no new paid services, no YouTube cookies, no self-hosted
runner, nothing to install on the owner's computer.

## Owner checklist: six values pasted into GitHub, then one button (about 20 minutes, once)

Everything happens in web browsers. Copy each value below and paste it at
**GitHub → jchardukian/Unhinged-Toaster → Settings → Secrets and variables → Actions → New repository secret**
(name exactly as written).

| Secret name | Where to get the value |
|---|---|
| `BUFFER_API_KEY` | Buffer → Settings → API → Create API key |
| `OPENAI_API_KEY` | platform.openai.com → API keys → Create new secret key (a project key is fine) |
| `ELEVENLABS_API_KEY` | elevenlabs.io → profile icon → API keys → Create |
| `CLOUDFLARE_ACCOUNT_ID` | dash.cloudflare.com → Workers & Pages → "Account ID" on the right-hand side |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens → Create Token → "Create Custom Token": permissions **Account · Workers Scripts · Edit**, **Account · D1 · Edit**, **Account · Workers R2 Storage · Edit**, **Account · Account Settings · Read**, **User · User Details · Read**; Account Resources: your account; Continue → Create Token → copy |
| `TOASTER_API_TOKEN` | any long random text you make up (40+ characters, e.g. a password-manager password). It is the shared password between the pipeline and the Worker. |

Optional secrets: `ELEVENLABS_VOICE_ID` (pin a specific toaster voice; otherwise the first energetic voice in the
account is used) and `WORKER_GITHUB_TOKEN` (see "Optional extras").

Then:

1. **Deploy the control plane**: GitHub → Actions → "Deploy control plane (Cloudflare)" → Run workflow. It creates the
   database and the media bucket, applies the migrations, stores the Buffer key and the shared password as Worker
   secrets, deploys the Worker, checks the public media route, and commits the Worker URL to `config/worker-url.txt`
   so nothing else has to be configured. Re-running it is safe. (If the workflow is not listed yet, PR #1 has not been
   merged: merge it first, or ask Claude to trigger it on the branch.)
2. **Dress the channels**: paste `assets/brand/channel_description.txt` into YouTube Studio and the TikTok profile.
3. **Dry run**: GitHub → Actions → "Weekly batch" → Run workflow → tick `dry_run`. Read the readiness and funnel reports
   in the run summary (nothing touches Buffer).
4. **Real run**: the same workflow without `dry_run`: up to 21 Shorts rendered, 42 Buffer **drafts** (one YouTube, one
   TikTok per Short) on next week's 11:00 / 15:00 / 19:00 Chicago slots.
5. **Every Sunday** (the batch runs by itself at 07:00 Chicago): open Buffer, approve the drafts you like, delete the
   rest. Deleted drafts are detected within the hour and replaced on the next daily run. Nothing is ever published
   without your approval.

Optional, recommended: drop 6–10 YouTube Audio Library tracks into `assets/music/` and list them in
`assets/music/manifest.json` (assets/music/README.md); until then videos ship without a music bed.

## What runs where

- **GitHub Actions**: `pipeline-daily.yml` (daily, 03:17 Chicago: discover → score → keep 10 finished Shorts in stock →
  fill open slots), `weekly-batch.yml` (Sundays 07:00 Chicago: up to 21 Shorts → 42 drafts → readiness report; exits
  red and opens an issue if the week is not fully covered), `deploy-cloudflare.yml` (on demand), `buffer-sync.yml`
  (only if the Worker is not used). All are also runnable by hand from the Actions tab.
- **Cloudflare Worker `toaster-api`**: database (D1), public media at `<worker-url>/media/<key>` (what Buffer fetches;
  200 with content-length, 206 for range requests), Buffer approval poller every 30 minutes, nightly metrics.
- **Buffer**: every post is created as a draft (`saveToDraft`); the client refuses anything that would publish. YouTube
  and TikTok drafts are separate posts, approved or deleted independently.

## Exactly which settings the launch uses

Required: the six secrets above. Written automatically: `config/worker-url.txt` (by the deploy workflow).
Everything else has a working default baked into the repository or `.env.example`: Buffer organisation and channel ids,
time zone `America/Chicago`, slots `11:00,15:00,19:00`, `TRANSFORMATION_REVIEW=true`, `MAX_COPYRIGHT_RISK=medium`,
`COMMENTARY_DEFAULT=auto`, `MUSIC_DEFAULT=auto`, `STICKERS=false`, `ENABLE_YOUTUBE_TRANSFORM=true` (YouTube is
discovery-only on GitHub runners), discovery `reddit_rss` + Internet Archive fillers.
Not used and not approved: `YTDLP_COOKIES_B64`, `YTDLP_ASSUME_FETCHABLE`, self-hosted runners.
Optional (Actions **variables**, not secrets): `ELEVENLABS_VOICE_ID`, `BUFFER_TAG_REVIEW_ID` / `BUFFER_TAG_CLEARED_ID`,
`REDDIT_*` app credentials (real vote counts, no feed rate limits), `YOUTUBE_API_KEY` (as a secret), `ALERT_WEBHOOK_URL`.

## Optional extras

- `WORKER_GITHUB_TOKEN` (GitHub secret, consumed only by the deploy workflow and stored as the Worker secret
  `GITHUB_TOKEN`): a GitHub fine-grained personal access token for repository `jchardukian/Unhinged-Toaster` with
  **Actions: Read and write** (Metadata: Read is added automatically). With it, the Worker starts replacement renders
  right after you delete a draft; without it, replacements happen on the next daily run. Never used by Actions itself.
- Running the setup from a computer instead of GitHub: `cp .env.example .env`, fill in the same values, run
  `scripts/deploy-cloudflare.sh` (browser login) and `scripts/setup-github-secrets.sh` (`gh auth login`). Same code path.

## Security properties

- Secrets live only in GitHub's encrypted store and Cloudflare's secret store; GitHub masks them in logs; the scripts
  read them from the environment or by parsing `.env` (never `source`d) and print names only; `.env`, `.env.*`, `work/`
  are git-ignored; the repository contains no key files; the deploy workflow verifies the presence of secrets by name,
  stops with a plain message when one is missing, and commits only the public Worker URL.
- Least privilege: the Cloudflare token covers Workers, D1 and R2 only; the optional GitHub token covers Actions on one
  repository; the Worker's API password is random and separate from everything else.
- Idempotent: the deploy workflow and both scripts can be re-run at any time without creating duplicates or rotating
  the shared password.

## What was verified where

- Verified in this environment: D1 migrations 0001–0005 on a local D1; `wrangler deploy --dry-run` with the `DB` and
  `MEDIA` bindings; a local Worker answering auth (401), upload, public media (200 / range 206 / HEAD), the readiness
  report, the dispatch guard and the sync cron; the deploy script end to end against a fake `wrangler` (create → list →
  migrate → secrets → deploy → URL recorded, idempotent, no secret value in any output).
- Verified with mocked tests: 21 productions → 42 drafts on the planned slots, idempotent re-runs, independent
  approval, confirmed-rejection replacement, clean public text. Verified live earlier: Buffer draft create → read → delete.
- **Not verified live** (needs the owner's accounts): the remote Cloudflare deploy, the 42-draft Buffer run, GitHub
  Actions wall time. The deploy workflow's own media-route check and the weekly dry run cover these before any draft
  is created.

## Costs at 21 videos/week (measured in the production test)
API $0.039 per Short → about $1/week, $4–8/month including daily discovery; GitHub Actions ≈ 75 min per weekly batch plus
15–45 min per daily run (free for a public repository; 2 000 free minutes/month for a private one); R2 ≈ 0.7 GB/week
(10 GB free); Cloudflare Workers/D1 free tier; Buffer existing plan; Reddit free.

## Dog pilot credentials (paid AI generation is PAUSED; only the free stock keys matter now)

| Secret | Needed for | Where |
|---|---|---|
| `GEMINI_API_KEY` | AI dog clips with Google `gemini-omni-1.2-flash` (≈ $0.07 per 720p second; the pilot's $25 cap ≈ 30 attempts of 12 s) | aistudio.google.com → Get API key; enable billing on the Google Cloud project (video is paid-tier only) |
| `RUNWAY_API_KEY` | AI dog clips with Runway (`kling_4_flash` ≈ $0.094/s, `gen4.5` $0.12/s, `veo3.1_fast` $0.15/s) | dev.runwayml.com → API keys; buy credits ($0.01 each, no subscription; $15 covers the benchmark) |
| `PEXELS_API_KEY`, `PIXABAY_API_KEY` | real-dog rankings from licensed stock | pexels.com/api and pixabay.com/api (free, instant) |
| variable `SFX_PROVIDER=elevenlabs` | build the real sound-effects library once with the ElevenLabs key already in use | Settings → Variables |

AI keys are NOT needed while generation is paused (the workflow's ai_count and ai_video_budget default to 0). For the
free real-dog pilot the two stock keys are optional but recommended: without them only Wikimedia Commons and the
Internet Archive (no key) are searched. Nothing here is required for the existing general-viral production.
