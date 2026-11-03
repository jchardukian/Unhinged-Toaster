# Architecture

```
┌──────────────── GitHub Actions (compute plane, FFmpeg) ────────────────┐
│ pipeline-daily.yml   discover → score → dedupe → rights gate →          │
│                      transcript → copy → TTS → render → upload (R2)     │
│ weekly-batch.yml     top up to 21 productions → create Buffer DRAFTS    │
│ buffer-sync.yml      (fallback poller when the Worker is not deployed)  │
└──────────────┬──────────────────────────────────────────▲───────────────┘
               │ REST (Bearer API_TOKEN)                  │ workflow_dispatch
┌──────────────▼──────────────────────────────────────────┴───────────────┐
│ Cloudflare Worker  toaster-api  (control plane)                          │
│   D1  toaster-db   candidates / productions / posts / weights / events   │
│   R2  toaster-media  renders/<candidate>/<file>.mp4 (+ thumbnails)       │
│   cron */30m  poll Buffer → approved? pin dueAt; deleted? replacement    │
│   cron daily  pull metrics → category weights (learning)                 │
│   cron Sunday dispatch weekly batch                                      │
└──────────────┬───────────────────────────────────────────────────────────┘
               │ GraphQL https://api.buffer.com
┌──────────────▼───────────────────────────────────────────────────────────┐
│ Buffer  YouTube channel 6ae95257…  TikTok account 6ae9500e…               │
│   drafts (saveToDraft) carrying dueAt = planned slot                      │
│   you approve ("Add to queue") or delete in the Buffer UI                 │
└───────────────────────────────────────────────────────────────────────────┘
```

## Weekly loop (what you see)

1. **Sunday 07:00 Chicago** – `weekly-batch.yml` renders until 21 finished shorts exist, then creates **42 drafts**
   (21 × YouTube + 21 × TikTok) in Buffer, each with its planned `dueAt` (Mon–Sun, three slots per day from `PUBLISH_SLOTS`).
2. **You open Buffer** → Drafts. Approve the ones you like (Add to queue / Schedule). Delete the ones you don't.
3. **Every 30 min** the Worker polls Buffer (there are no webhooks) using `shared/sync.ts` (`runSync`), per post and per service:
   - draft → `scheduled`: marked approved; if Buffer put it in a different slot, `editPost` pins it back to the planned `dueAt` and the returned dueAt is verified.
   - "Post not found" twice, ≥ 10 min apart: marked **rejected** for that service only; a replacement is produced and drafted for that slot (via `workflow_dispatch`). The same production is never re-drafted into a slot where it was rejected.
   - any transport / 5xx / 429 / GraphQL error: state unchanged, `sync_error` recorded, reported.
   - `sent`: marked published; metrics are pulled daily and feed category weights.
   - candidate status = f(all its posts): any sent → published; any scheduled → approved; all deleted → rejected_user.
4. **Draft creation is idempotent**: before each create (and before each retry) Buffer is queried for a post at the same channel + instant (±90 s) and adopted if present, so a timed-out request never produces duplicates. Each post row carries `idempotency_key = week|slot|service`.
5. **Readiness report** (`shared/report.ts`): target 21 videos / 42 posts, discovered → scored → cleared → rendered → drafted → awaiting / approved / published / rejected, missing slots and shortage reasons. `run-weekly` exits non-zero and alerts (Actions summary, GitHub issue, optional webhook) when incomplete.

Everything else is automatic. Nothing is ever published by the pipeline itself: `createPost` is always called with
`saveToDraft: true` (or `needsApproval: true` if you move to Buffer's Team plan and set `BUFFER_APPROVAL_MODE=needs_approval`).

## Buffer API facts this design relies on (verified 2026-11-02)

- Endpoint `https://api.buffer.com` (GraphQL), `Authorization: Bearer <key>` from **Settings → API**.
- `createPost` input: `channelId, text, schedulingType: automatic, mode: addToQueue|customScheduled|shareNow|shareNext, dueAt, saveToDraft, needsApproval (Team), assets:[{video:{url}}], metadata.youtube{title,categoryId,privacy,madeForKids,notifySubscribers,license,isAiGenerated}, metadata.tiktok{title,isAiGenerated}`.
- Buffer **fetches the video from the URL at create time** and rejects unreadable URLs ("Video could not be read from its URL"), so the R2 bucket must be publicly reachable before drafts are created.
- `posts` query filter: `status ∈ {draft, needs_approval, scheduled, sending, sent, error}`, `channelIds`, `dueAt/createdAt` ranges; cursor pagination, 100 max per page; aliased `post(id)` lookups, ≤ 30 aliases/query.
- `editPost` with `dueAt` + `mode: customScheduled`; `deletePost`.
- Metrics: `Post.metrics {type value}` + `metricsUpdatedAt`, `aggregatedPostMetrics` (refresh ~daily).
- Rate limits (Essentials): 450 / 15 min, 1 800 / 24 h, 3 000 per channel / 30 d. Our steady-state usage is < 100 calls/day.
- No webhooks → polling. Cursors are not stable across runs → we poll by post id.

## Scoring

`final = 0.4 × heuristic + 0.6 × llm`, times the learned category weight (0.6–1.6). Threshold 62.
- **heuristic** (`shared/scoring.ts`): log-scaled like velocity (likes/hour), comment+share depth, like/view ratio, short-form fit (6–30 s ideal).
- **llm**: rubric entertainment / surprise / clarity / brand_fit / rewatchability (0–10 each) + safety flags.
  Hard blocks: nsfw, hate, graphic_injury, minor_humiliation, death, animal_cruelty, self_harm, private_person_mocking.
- **learning**: for every published post older than 48 h, `views` by category vs global mean → EMA-updated category weight.

## Dedupe

Exact (normalised URL) → perceptual (64-bit DCT pHash on 5 sampled frames, mean Hamming ≤ 10 with ±1 frame tolerance)
→ textual (title trigram Jaccard ≥ 0.8 and duration within 1.5 s).

## Comedic edit engine (`shared/editplan.ts`, `pipeline/steps/analyze.ts`, `render.ts`)

1. `analyzeClip`: per-100 ms audio RMS (astats) and per-frame scene-change scores → `detectPeak` (largest audio onset, else loudest moment, else strongest scene change, else 62 % of the clip).
2. The copywriter LLM also acts as director: `sticker` (1–3 word reaction), `freeze_text`, `edit_style` (full/light).
3. `planEdit` builds the timeline: freeze-frame 1 s before the peak (skipped inside dialogue), punch-in zoom ×1.28 at the peak, slow-motion replay (0.5×) of peak ± 0.8 s with a REPLAY label, reaction sticker popping at the peak, outro with the spoken commentary. Beats are dropped (replay first, then freeze) to stay ≤ 59 s. Caption timings are remapped across the freeze.
4. Source audio is muted when the scorer flags commercial music; the replay audio is the slowed original.

## Rendering (`packages/pipeline/src/steps/render.ts`)

Single FFmpeg graph, 1080×1920 @ 30 fps, H.264 CRF 20, AAC 160k, loudnorm −14 LUFS:
animated background (brand loop or procedurally rotated sunburst) → drop shadow → clip scaled into a 1000×1040 window
with a yellow comic frame → headline in the speech-burst box (Bangers, auto-wrapped, auto-sized) → ASS karaoke captions
(Whisper word timings; yellow active word) → outro freeze-frame with commentary box + ElevenLabs VO → watermark + handle →
bobbing mascot. Template geometry lives in `template/template.json`.

## Costs (estimate at 21 videos/week)

GitHub Actions ≈ 2–3 h/week (free tier), Cloudflare Workers/D1/R2 free tier, OpenAI (gpt-4o-mini + whisper-1) < $1/week,
ElevenLabs ≈ 2 k characters/week (free/starter tier), Buffer Essentials (existing).
