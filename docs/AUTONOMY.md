# Unattended operation (autopilot)

Goal: the channel runs for weeks with no human review, approval or scheduling. This document is the contract: what the
system does on its own, what it refuses to do, the one-time authorization, the emergency stop, and the validation that
has to pass before the switch is turned on. Everything here is implemented in code and covered by tests
(`packages/shared/test/autopilot.test.ts`, `packages/pipeline/test/autonomy.test.ts`).

## The five gates every post passes before it is scheduled without approval

1. **Rights (never bypassed).** Only footage whose reuse right is DOCUMENTED on the candidate record qualifies:
   `rights_status = cleared` with basis `cc0`, `public_domain`, `cc_by` (uploader-asserted CC BY with low provenance
   risk), `pexels_license`, `pixabay_license`, `written_permission`, `licensed` or `owned`, plus non-empty evidence
   (licence URL, API field, archived message). Transformation review, owner-reviewed, popularity, attribution, editing
   or commentary never qualify (`shared/autopilot.ts: unattendedEligible`). Candidates without documented rights are
   skipped (logged as `skip`) or, if `UNATTENDED_REVIEW_DRAFTS=true`, drafted for optional approval.
2. **Automated quality control** (`pipeline/steps/qc.ts`), run on the FINISHED file independently of production:
   1080x1920, 5-60 s, audio present, decodes cleanly, audio/video length drift ≤ 0.5 s, no black frames ≥ 0.4 s, no
   frozen span ≥ 2.6 s, loudness -22…-8 LUFS, not mostly silent, no second production of the same source (duplicates),
   no hard safety flag, no profanity in headline/caption/captions, caption timing inside the timeline, caption accuracy
   (the final mix is re-transcribed and ≥ 60 % of caption words must be heard), credit block present (source, creator,
   contact), no internal review text, headline/caption length limits, and an editorial vision check of six frames of the
   final render: opening hook, clear comedic payoff, entertainment (each ≥ 6/10), no visual defects (black bars, cut-off
   text, overlapping overlays, unreadable captions…), brand visible. A blocking failure sets the candidate to
   `rejected_qc` and a replacement is produced. Verdict and score are stored on the production (`qc_json`, `qc_score`).
3. **Minimum QC score** `UNATTENDED_MIN_QC` (default 7 of 10) from the editorial check.
4. **Duplicate publishing prevention**: one production per source (QC), idempotent slot keys, Buffer is queried for a
   post already at the slot before creating, decisions carry the production id.
5. **Authorization + health**: the switch, the phrase, no emergency stop, no pause record (below).

## Switching it on (one-time owner authorization)

Unattended publishing is OFF by default and cannot be turned on by code, by a workflow input or by ChatGPT. The owner
sets two repository **variables** (GitHub → Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `UNATTENDED_PUBLISHING` | `true` |
| `UNATTENDED_AUTHORIZATION` | exactly: `I authorize The Unhinged Toaster to publish automatically without my review` |

Both are read at the start of every daily / weekly run. The Buffer client itself refuses any non-draft post unless the
exact phrase and a logged decision id are passed (`publish guard`), so no other code path can schedule. Optional:
`UNATTENDED_MIN_QC` (default 7), `UNATTENDED_REVIEW_DRAFTS=true` to keep drafting review-path videos for the owner.

`toaster autopilot:status` (and the step summary of every run) prints ACTIVE or the exact list of missing conditions.

## Stopping it

- **Emergency stop**: GitHub → Actions → "Emergency stop (pause unattended publishing)" → Run workflow. It writes a pause
  record to the control plane and DELETES every pending (not yet published) scheduled post from Buffer. Drafts and
  already-published videos are untouched. Works even if the variables are still set.
- Repository variable `EMERGENCY_STOP=true`: every run refuses to schedule (no network needed).
- `toaster stop --reason "..."` does the same from a terminal; `toaster resume` clears the pause record.

## Automatic pause (monitor)

After every publish the monitor evaluates (`shared/autopilot.ts: monitorVerdict`): ≥ 2 Buffer publishing errors in
24 h, QC pass rate < 25 % over the last 12 productions, ≥ 2 consecutive run failures, API budget exhausted, a circuit
breaker tripped, or a recorded platform incident. Any of these pauses unattended publishing, unschedules pending posts
and raises an alert (webhook + GitHub issue). Copyright complaints and platform warnings are not visible through Buffer:
record them with `toaster incident "<text>"` (or the owner's issue) and the monitor pauses immediately.

## Decision log

Every scheduling decision (schedule / skip / hold / pause / resume / unschedule / stop) is written to the control plane
(`decisions` table, `GET /decisions`), to `work/publish-decisions.jsonl` in the run artifact, and to the run log, with
the production, candidate, service, slot, Buffer post id, reasons (rights basis and evidence, QC score) and who decided.

## Validation before launch (finite)

1. Run as today (drafts only) with QC enforced. Every production gets a QC verdict and score.
2. The owner approves or deletes drafts ONCE for a sample of at least 30 videos (one weekly batch plus a few days).
3. `toaster calibration` compares the owner's verdicts with the automated QC: readiness = ≥ 30 decided videos and QC-pass
   precision ≥ 85 % (owner approved among QC-passed). It also recommends `UNATTENDED_MIN_QC`.
4. When ready, the owner sets the two variables. From then on nothing needs approval; the monitor and the emergency stop
   are the controls.

## What this cannot do (genuine limits)

- Rights supply: unattended publishing only uses documented-licence footage. Viral clips from Reddit, TikTok and standard
  YouTube uploads have no documented right and are never published unattended; they can be drafted for the owner
  (`UNATTENDED_REVIEW_DRAFTS=true`) or produced only when a documented permission exists. The measured supply of funny
  licensed footage (Pexels / Pixabay / Commons / Archive / CC BY) is small; expect fewer than 3 videos a day until
  that supply or a licensing deal exists.
- Platform signals: YouTube/TikTok complaints, strikes and warnings are not exposed by Buffer. They arrive by e-mail to the
  owner; the `incident` command is the hook.
- Footage retrieval from GitHub-hosted runners: see docs/SOURCES.md for the current state per source.

## Costs with unattended operation (per video, list prices)

Scoring ≈ $0.001, vision re-score + copy ≈ $0.01, QC (vision + re-transcription) ≈ $0.01, captions ≈ $0.006, voice
(ElevenLabs free tier) ≈ $0, render on GitHub Actions ≈ 3-9 minutes of free runner time, storage on R2 free tier.
≈ $0.05 per finished video; 3 per day ≈ $4.50 per month plus daily discovery (≈ $0.10 per day). Budget caps:
`API_BUDGET_USD` per run (defaults $8 daily / $15 weekly / $2 diagnostics); the run stops when it is used up.
