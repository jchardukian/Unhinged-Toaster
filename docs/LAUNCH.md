# Launch checklist (owner policy of 2026-11-07: edited viral clips with a supportable fair-use basis)

What the system does on its own once launched: discover (Reddit now; YouTube/TikTok metadata only until a fetch path
exists) → score → download → vision re-score + watermark credit → copy (headline, original commentary, caption) →
edit plan → captions → render (brand, mascot, SFX, animated border) → automated QC (technical + editorial) → case-specific
fair-use assessment → Buffer post → monitor. Nothing is manual after the one-time setup below.

## Rights model (read once)
- **Documented licence** (CC0 / public domain / CC BY with low provenance risk / Pexels / Pixabay / written permission /
  licensed / owned): recorded as `cleared` with evidence. Eligible for unattended publishing.
- **Fair-use assessment** (everything from Reddit / YouTube / TikTok with a standard licence): the pipeline records
  seven factors per video (nature of source, provenance, transformation, amount used, music, market effect, people) and
  a verdict. `supportable` = every verifiable factor in favour (amateur UGC, self-posted, no foreign watermark, low rated
  risk, original commentary + edits, commercial music muted, no private-person mocking); market effect is ALWAYS
  recorded as an assumption. `uncertain` = at least one factor could not be verified or points the other way (medium
  risk, foreign watermark, compilation signals, no commentary). `not_supportable` = broadcast / professional / high
  risk / unmuted music / mocking private people. This is an assessment, not a licence and not legal advice; it is
  stored on the production and copied into every scheduling decision.
- Unattended scheduling uses `supportable` assessments ONLY when the owner sets `UNATTENDED_FAIR_USE=true`.
  Measured on the three launch samples (Reddit reposts): the model rates most Reddit sources "medium" ("poster may not
  be the filmer"), which makes them `uncertain` under the default. `UNATTENDED_FAIR_USE_MAX_RISK=medium` tells the
  assessment to count medium-rated risk in favour (high stays against, foreign watermarks and compilations stay
  uncertain). Without it, expect most Reddit videos to be held for your approval rather than scheduled.
  `uncertain` videos are never scheduled unattended; with `UNATTENDED_REVIEW_DRAFTS=true` they become Buffer drafts for
  optional owner approval, otherwise they are skipped and logged.

## One-time owner actions (all in GitHub → Settings → Secrets and variables → Actions → Variables, unless noted)
1. Merge PR #4 and run Actions → "Deploy control plane (Cloudflare)" once (applies migrations 0006–0008).
2. Calibration (one time, ~1 week): leave the variables unset; the weekly batch drafts 21 videos with QC scores and
   fair-use verdicts. Approve or delete drafts once; then run Actions → Diagnostics… or `toaster calibration` from a
   run summary. Ready = ≥ 30 decided videos, QC-pass precision ≥ 85 %.
3. Switch on: `UNATTENDED_PUBLISHING=true`, `UNATTENDED_AUTHORIZATION=I authorize The Unhinged Toaster to publish
   automatically without my review`, `UNATTENDED_FAIR_USE=true`. Optional: `UNATTENDED_MIN_QC` (default 7),
   `UNATTENDED_REVIEW_DRAFTS=true`, `COMMENTARY_DEFAULT=text_only` while the ElevenLabs warning is open.
4. Stop at any time: Actions → "Emergency stop" → Run workflow, or `EMERGENCY_STOP=true`.

## What stays manual (by design)
- Reading platform e-mails (copyright claims, strikes). Record them with `toaster incident "<text>"` or set
  `EMERGENCY_STOP=true`; the monitor pauses on its own only for failures it can see (Buffer errors, QC collapse, budget).
- Nothing else.

## Audience (owner decision 2026-11-07, permanent)
English-language channel for viewers in the United States.
- Copy: the copywriter writes natural American English; British spellings are repaired automatically, British slang is
  rejected and rewritten, hashtags are ASCII English (`shared/language.ts`).
- Source language: Whisper's detected language is kept even for non-English speech (it used to be discarded as a
  "hallucination", which made foreign dialogue look like silence). The vision scorer reports whether the joke depends on
  dialogue, whether non-English on-screen text carries it, whether cultural context is needed, and how well it works
  muted. `languageGate` rejects before rendering (`rejected_language`, reason recorded) and again in QC on the finished
  file. Footage filmed abroad passes when the gag is universal; nothing is inferred from appearance, ethnicity or accent.
- QC editorial adds `us_fit` (≥ 6) and natural-American-English checks; failures are never scheduled.
