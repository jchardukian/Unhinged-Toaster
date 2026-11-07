# Funny-dog expansion: findings and pilot design (2026-11-07)

Status (2026-11-07): **pilot implemented** (opt-in `dog-pilot` command + "Dog pilot" workflow), exercised end to end with
the free mock provider and mock stock; no provider account, no paid generation, no dog content published, production
schedules untouched. Owner credentials needed before paid runs are listed at the end of docs/DEPLOYMENT.md.

Implemented pieces: `steps/aivideo.ts` (Gemini Omni 1.2 Flash, Runway kling_4_flash / gen4.5 / veo3.1_fast, mock) behind one
`VideoProvider` interface with a HARD `AI_VIDEO_BUDGET_USD` cap; `steps/dogprompts.ts` (20 premises, realism constraints,
LLM variation); `steps/dogquality.ts` (vision gate: anatomy, motion, lighting, artifacts, 2-s hook, payoff, SFX fit;
strict pure decision rule); `steps/sfx.ts` (10-effect library, ElevenLabs sound-generation or free placeholders kept out of
assets/, cues on real beats) + an SFX bus in `render.ts`; `steps/ranking.ts` (3–5 licensed clips, badges, labels,
cross-fades, cut whooshes, #1 fanfare, then the normal branded render); `steps/dogpilot.ts` (orchestrator, cost per
ACCEPTED video, shortages reported not filled, report + contact sheet); `content_format` on candidates/productions/posts
(migration 0006) with a per-format table in the readiness report.

## 1. What exists and what a dog pilot can reuse

| Component | File(s) | Reusable as-is for dogs? |
|---|---|---|
| Candidate / production store (D1 via the Worker, JSON locally) | `packages/shared/src/types.ts`, `packages/worker/migrations/*` | yes; needs 2 new columns (`content_format`, generation cost fields) |
| Rights policy, credit block | `packages/shared/src/rights.ts` | yes; needs one new basis `ai_generated` (cleared, evidence = provider terms + job id) |
| Download dispatch per platform | `packages/pipeline/src/steps/media.ts` `downloadMedia` | yes; AI clips are written straight into the job folder, so a new `source_platform: 'ai_generated'` case just returns the file |
| Vision pass (contact sheet → LLM re-score, watermark reader) | `steps/frames.ts`, `steps/score.ts` | yes; add a "realism" rubric item for generated clips |
| Copy (headline, commentary, sticker, freeze text) | `steps/copy.ts` | yes |
| Edit planner (peak detection, freeze, punch-in, replay) | `packages/shared/src/editplan.ts`, `steps/analyze.ts` | yes for single clips; rankings need a multi-clip timeline |
| Renderer (1080×1920, full-bleed layout, libass headline + captions, mascot, wordmark, music bed, loudnorm) | `steps/render.ts` | yes for Format A; Format B needs a `segments[]` input with rank badges and transitions |
| Narration (ElevenLabs), captions (Whisper) | `steps/tts.ts`, `steps/captions.ts` | yes |
| Budget / breaker / timeouts, usage meter | `guard.ts`, `usage.ts` | yes; add a video-generation counter and a separate `AI_VIDEO_BUDGET_USD` |
| Upload, Buffer drafts, approval sync, replacements | `steps/upload.ts`, `steps/publish.ts`, `steps/sync.ts`, Worker | yes, unchanged |
| Performance learning | `steps/sync.ts` `learn`, `category_weights` | partly: today it learns by content category from Buffer views only; needs per-format tracking |
| Diagnostics ladder, GitHub workflows | `steps/ladder.ts`, `.github/workflows/*` | pattern reused for an opt-in `dog-pilot.yml` |
| Stock adapters Pexels / Pixabay | `steps/discover.ts` | yes, but both need free API keys the owner has not added |
| Sound effects | none | **missing**: no SFX library, no SFX mixing in the render graph |
| Music bed | `assets/music/manifest.json` | **still only the example entry** → videos ship without music |

## 2. AI video providers (verified from official pages on 2026-11-07)

**Google Gemini API.** Veo 3.1 / 3.1 Fast / 3.1 Lite were **shut down on 22 Oct 2026** (the prices quoted in the
review no longer exist). Video generation is now **Gemini Omni 1.2 Flash**: output billed per token, ≈ **$0.07 / s at
720p** ($0.023 at 360p, $0.104 at 1080p upscaled); 3–15 s per clip; `aspect_ratio: "9:16"` supported; audio generated
by default; image/reference input (up to 6 images); download via base64 or file URI polling. Terms: "Google won't claim
ownership over that content"; use limited to "professional or business purposes". Endpoint
`POST https://generativelanguage.googleapis.com/v1beta/interactions` (reachable from this environment; no key here).

**Runway developer API** (1 credit = $0.01, no subscription, no stated minimum): Gen-4 Turbo $0.05/s (image-to-video
only), Gen-4.5 $0.12/s (text-to-video, portrait `720:1280` confirmed), Kling 3.0 Standard $0.09/s (+audio $0.13),
Kling 4.0 Flash $0.094/s (720p, 3–20 s, portrait `720:1280`, audio included), Kling 4.0 $0.126/s promo to 30 Nov
($0.157 list; 1080p `1080:1920` available at $0.188–0.235), Veo 3.1 Fast $0.15/s with audio (ratios not documented).
Outputs are URLs that expire in 24–48 h (must be stored, which the pipeline already does). Host reachable (401 = key
required).

**Kling direct**: official docs and pricing pages render empty (JavaScript only); prepaid packages. Not evaluable
without an account → use Kling through Runway for the pilot.

**Recommendation**: benchmark **Gemini Omni 1.2 Flash** (cheapest with audio, native 9:16, up to 15 s in one shot,
official API) against **Kling 4.0 Flash via Runway** (same clip length, one platform for Gen-4.5/Kling/Veo if the first
choice disappoints). Pick by usable realistic clips per dollar after a 6-clip benchmark each (~$12 total).

## 3. Cost per finished AI dog Short (estimate, to be measured in the pilot)

| item | Gemini Omni 720p | Kling 4.0 Flash (Runway) |
|---|---|---|
| one 12 s attempt | $0.84 | $1.13 |
| attempts per usable clip (assumed 2, i.e. 50 % yield) | $1.68 | $2.26 |
| existing pipeline (vision re-score, copy, TTS, Whisper) measured | $0.04 | $0.04 |
| SFX (ElevenLabs sound-generation, 200 credits each; one-time 12-sound library ≈ 2,400 credits, within the 10k/month free tier) | ≈ $0 | ≈ $0 |
| **per finished Short at 50 % yield** | **≈ $1.75** | **≈ $2.30** |
| at 33 % yield | ≈ $2.6 | ≈ $3.4 |
| 30 per month | $52–78 | $69–102 |

Hard rule (kept): track attempts, usable attempts, generated seconds, provider charge and cost per *approved* Short;
`AI_VIDEO_BUDGET_USD` stops generation when exhausted (pilot cap $25).

## 4. Real-dog footage with rights

- **Pexels** (free API key, 200 req/h): license allows commercial use and modification, no attribution, forbids
  implying endorsement and unaltered resale. Search "funny dog" ≈ 3.9K videos, "dog fail" ≈ 11K, but the first pages
  are generic stock (dogs in strollers, dogs on mountains, "dogs barking at the TV"): **not comedy**.
- **Pixabay** (free API key, 100 req/min, 24 h caching rule): Content License allows modification and commercial use,
  no attribution; "funny dog" ≈ 1,272 videos, same generic character, some 3D/cartoon.
- Expected yield of genuinely funny licensed clips: low (single digits per hundred). The existing vision scorer can
  measure it automatically (entertainment ≥ 7 on the rubric) before anyone promises a daily compilation.
- Reddit dog subs (r/WhatsWrongWithYourDog, r/AnimalsBeingDerps) already feed funny dog clips through the
  transformation-review path; a 5-clip ranking would carry 5 creators' footage per video. Keep rankings to licensed
  stock + creator-permission clips, or accept that review-path rankings multiply exposure (decision for the owner).

## 5. Minimum changes for a 10-video pilot (4 AI, 4 rankings, 2 general controls)

1. `types.ts` + migration `0006_dog_pilot.sql`: `content_format` ('ai_dog_comedy' | 'real_dog_ranking' | 'general_viral')
   on candidates, productions and posts; `generation_json` on candidates (provider, model, prompt, attempts,
   generated_seconds, cost_usd); `production_cost_usd` on productions.
2. `rights.ts`: basis `ai_generated` → cleared, evidence "provider terms (date) + job id".
3. `steps/aivideo.ts`: provider interface `{ generate({prompt, seconds, ratio}) → mp4 path }` with `gemini` and `runway`
   implementations (submit → poll → download), metered through `guard.ts` (`AI_VIDEO_BUDGET_USD`, breaker on 4xx).
4. `steps/dogprompts.ts`: ~20 premise templates (oversized stick in doorway, pillow-pile landing, blanket burrito,
   copying the owner's workout…), prompt builder with realism constraints (handheld phone footage, natural light, one
   dog, no text, no humans' faces, no transformations), LLM variation.
5. Vision gate for generated clips: existing re-score + "realistic_dog" item; reject artifacts, retry ≤ 3 per premise.
6. `render.ts`: `segments[]` mode for rankings (xfade cuts, "#5 … #1" badges via libass, strongest clip first, payoff
   last); SFX bus: `adelay` + `amix` of SFX files at `timeline` beats (peak, cuts, freeze).
7. `assets/sfx/` + `manifest.json` + `scripts/make-sfx.ts` (ElevenLabs sound-generation, one-time: slip, thud, record
   scratch, boing, whoosh, tiny victory, dramatic sting, dog sneeze); only manifest-listed files are mixed.
8. `cli.ts dog-pilot --ai 4 --rankings 4 --controls 2 [--provider gemini|runway]` + `.github/workflows/dog-pilot.yml`
   (workflow_dispatch, budget input, no Buffer posts; artifacts: videos + contact sheet + cost table).
9. Tracking: `post_metrics` snapshots at 24 h / 72 h / 7 d (table `post_metrics`), `learn` aggregates by
   `content_format` (views, likes, shares, comments per 1k views, normalised by age), readiness report section per
   format; YouTube Analytics API (average view duration, average percentage viewed, subscribers gained) requires an
   OAuth consent by the owner — proposed after the pilot, not before.
10. Owner-side (no terminal): a Google AI Studio API key with billing enabled (`GEMINI_API_KEY` secret) and/or a Runway
    developer key with ~$15 credits (`RUNWAY_API_KEY`), free Pexels and Pixabay keys, and the still-missing music tracks.

Estimated effort: 2–3 working sessions; the renderer ranking mode and the SFX bus are the only non-trivial code.

## 6. Blockers (genuine)

- No AI-video key in any environment yet; nothing can be benchmarked until the owner creates one account.
- Veo 3.1 no longer exists in the Gemini API; realism of Gemini Omni 1.2 Flash and Kling 4.0 Flash for dogs is unproven.
- Runway's Veo 3.1 ratios and Gen-4.5 durations are undocumented on the public pages; Kling's own docs are unreadable.
- Licensed stock is plentiful but rarely funny; Format B yield is unknown until measured.
- No SFX library and no music tracks exist yet.
- Buffer metrics give views/likes/comments/shares only; retention needs YouTube Analytics OAuth.
