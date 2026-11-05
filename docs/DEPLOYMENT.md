# Deployment (Reddit-only launch, free tiers, existing accounts)

Everything runs on GitHub Actions (compute), Cloudflare Workers + D1 + R2 (control plane, database, public media; free
tier), Buffer (existing account), OpenAI (pay-as-you-go, under $1/week measured), ElevenLabs (existing account, free tier
covers the weekly narration). No paid licensing, no new paid services, no YouTube cookies, no self-hosted runner.

## Launch checklist in plain language (about 30 minutes, once)

You need a computer with Node.js 22 and Git, the GitHub CLI (`gh auth login`, log in through the browser) and a free
Cloudflare account. Run the commands from the repository folder.

1. **Copy the settings file**: `cp .env.example .env` and open `.env` in a text editor.
2. **Paste three keys** into `.env`: `BUFFER_API_KEY` (Buffer → Settings → API), `OPENAI_API_KEY` (platform.openai.com →
   API keys), `ELEVENLABS_API_KEY` (elevenlabs.io → profile → API keys). Optionally `ELEVENLABS_VOICE_ID` to pin the
   toaster voice. Never share `.env`: it is ignored by Git and only ever read by the two scripts below.
3. **Create the control plane**: `scripts/deploy-cloudflare.sh`. The first run opens a browser window for the Cloudflare
   login. The script creates the database and the media bucket, applies the migrations, stores `BUFFER_API_KEY` and a
   generated `API_TOKEN` as Worker secrets, deploys the Worker and **writes `TOASTER_API_TOKEN` and `TOASTER_API_URL` into
   `.env` itself** (nothing secret is printed). Re-running it is safe.
4. **Hand the keys to GitHub**: `scripts/setup-github-secrets.sh`. It reads `.env`, stores the keys as encrypted Actions
   secrets and the plain settings as Actions variables, and prints only their names. `--dry-run` shows what it would set.
5. **Merge PR #1** (the scheduled workflows only run from the `main` branch).
6. **Dress the channels**: paste `assets/brand/channel_description.txt` into YouTube Studio and the TikTok profile
   (docs/CHANNEL_DESCRIPTION.md). Optional but recommended: drop 6–10 YouTube Audio Library tracks into `assets/music/` and
   list them in `assets/music/manifest.json` (assets/music/README.md); until then videos ship without a music bed.
7. **Dry run**: GitHub → Actions → "Weekly batch" → Run workflow → tick `dry_run`. Read the readiness and funnel reports
   in the run summary (nothing touches Buffer).
8. **Real run**: the same workflow without `dry_run`. It renders up to 21 Shorts and creates 42 Buffer **drafts** (one
   YouTube, one TikTok per Short) on next week's 3 daily slots.
9. **Every Sunday** (the batch runs automatically at 07:00 Chicago): open Buffer, approve the drafts you like
   ("Add to queue" / schedule), delete the ones you do not. Deleted drafts are detected within an hour and replaced on the
   next daily run; nothing is ever published without your approval.

## Exactly which settings the Reddit-only launch needs

| Setting | Where it comes from | Required |
|---|---|---|
| `BUFFER_API_KEY` | Buffer → Settings → API | yes |
| `OPENAI_API_KEY` | OpenAI project key (scoring, copy, vision checks, Whisper captions) | yes |
| `ELEVENLABS_API_KEY` (+ `ELEVENLABS_VOICE_ID`) | ElevenLabs profile → API keys | yes (voice id optional) |
| `TOASTER_API_TOKEN`, `TOASTER_API_URL` | written by `scripts/deploy-cloudflare.sh` | yes (automatic) |
| `WORKER_GITHUB_TOKEN` | GitHub → Settings → Developer settings → Fine-grained personal access tokens → repository `jchardukian/Unhinged-Toaster`, permission **Actions: Read and write** (Metadata: Read is added automatically). Stored as the Worker secret `GITHUB_TOKEN` by the deploy script; never sent to GitHub Actions. | no: it lets the Worker start replacement renders immediately after you delete a draft; without it, replacements happen on the next daily run |
| Buffer org / channel ids, time zone, slots | already baked into `.env.example` and `wrangler.toml` | no action |
| `BUFFER_TAG_REVIEW_ID`, `BUFFER_TAG_CLEARED_ID` | optional Buffer tags to mark drafts visually | no |
| `REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD` | optional free Reddit script app: real vote counts and no rate limits; the public feeds work without it | no |
| `YOUTUBE_API_KEY` | optional, metadata for the YouTube discovery path; YouTube is not fetched on GitHub runners | no |
| `YTDLP_COOKIES_B64`, `YTDLP_ASSUME_FETCHABLE`, self-hosted runners | **not used, not approved** | no |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_PUBLIC_BASE_URL` | only for the "without the Worker" variant below | no |
| `PIXABAY_API_KEY`, `PEXELS_API_KEY`, `ALERT_WEBHOOK_URL`, `ANTHROPIC_API_KEY` | optional fillers / alerts / alternative LLM | no |

Everything else in `.env.example` has a working default. The policy defaults are the launch configuration:
`TRANSFORMATION_REVIEW=true`, `MAX_COPYRIGHT_RISK=medium`, `COMMENTARY_DEFAULT=auto`, `MUSIC_DEFAULT=auto`, `STICKERS=false`,
`ENABLE_YOUTUBE_TRANSFORM=true` (discovery only on GitHub runners), discovery sources `reddit_rss` + Internet Archive fillers.

## What the two scripts do and never do

- `scripts/deploy-cloudflare.sh`: reads `BUFFER_API_KEY`, `WORKER_GITHUB_TOKEN` and `TOASTER_API_TOKEN` from `.env` by
  parsing the file (it is never `source`d, so nothing in it executes); checks the Cloudflare login (`wrangler whoami`,
  opens the browser login only when needed); creates D1 `toaster-db` and R2 `toaster-media` only if missing; applies all
  migrations remotely; reuses an existing `TOASTER_API_TOKEN` or generates one; puts the secrets with `wrangler secret
  put` through stdin; deploys; writes `TOASTER_API_URL` into `.env`. Stops with a plain-language message when `.env`,
  Node.js or `BUFFER_API_KEY` is missing. Prints no secret values.
- `scripts/setup-github-secrets.sh`: checks the required five settings are present, checks `gh auth status`, sets each
  secret with `gh secret set` through stdin and each variable with `gh variable set`; prints names only; `--dry-run`
  prints the plan without contacting GitHub. `WORKER_GITHUB_TOKEN` and `YTDLP_COOKIES_B64` are deliberately not in its lists.
- Neither script commits anything. `.env`, `.env.*` and `work/` are git-ignored; the repository contains no key files.
  GitHub Actions masks secret values in logs; the pipeline logs never print configuration values (`doctor` prints OK/MISS).

## How the pieces talk to each other

- GitHub Actions (`pipeline-daily.yml` daily, `weekly-batch.yml` Sundays, both also runnable by hand) run the pipeline:
  discover → score → fetch → render → upload to the Worker (`PUT /upload/<key>`, bearer `TOASTER_API_TOKEN`) → Buffer drafts.
- The Worker (`toaster-api`) holds the database (D1) and serves rendered media publicly at
  `<TOASTER_API_URL>/media/<key>` (200 with content-length, 206 for range requests; verified locally); Buffer fetches the
  video from there when the draft is created. It polls Buffer every 30 minutes for approvals and deletions, pulls
  metrics nightly, and (only with `WORKER_GITHUB_TOKEN`) triggers `weekly-batch.yml` on `main` via the GitHub REST
  `workflow_dispatch` endpoint to render replacements.
- Buffer: every post is created with `saveToDraft`; the client refuses anything that would publish. YouTube and TikTok
  drafts are separate posts and are approved or deleted independently.

## Without the Worker (not recommended)
Set the GitHub variable `BUFFER_SYNC_VIA_ACTIONS=true` (2-hourly Actions poller) and provide an R2 S3 token plus a public
bucket URL (`R2_*` settings), because Actions cannot serve files. Everything else is unchanged.

## What was verified where
- Verified locally (this session): D1 migrations 0001–0005 apply on a local D1; `wrangler deploy --dry-run` builds the
  Worker with the `DB` and `MEDIA` bindings; a local Worker answered auth (401 without/with wrong token), `PUT /upload`,
  public `GET /media` (200, content-length, range 206, HEAD), the readiness report, the dispatch guard and the sync cron.
- Verified with mocks (tests): 21 productions → 42 drafts on the planned slots, idempotent re-runs, independent
  approval, confirmed-rejection replacement, no review wording in public text.
- Verified live earlier: Buffer draft create → read → delete round-trip with a real API key.
- **Not verified live** (needs the owner's accounts): the remote Cloudflare deploy on the owner's account, the GitHub
  token dispatch, the full 42-draft Buffer run, and GitHub Actions wall time. The dry run in step 7 covers the first two
  halves before anything reaches Buffer.

## Costs at 21 videos/week (measured in the production test)
API $0.039 per Short → about $1/week, $4–8/month incl. daily discovery; GitHub Actions ≈ 75 min per weekly batch plus
15–45 min per daily run (free for a public repository; 2 000 free minutes/month for a private one); R2 ≈ 0.7 GB/week
(10 GB free); Cloudflare Workers/D1 free tier; Buffer existing plan; Reddit free.
