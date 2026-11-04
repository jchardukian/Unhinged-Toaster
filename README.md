# The Unhinged Toaster – automated viral Shorts pipeline

Three branded comedy Shorts per day on YouTube Shorts and TikTok, with a single weekly approval step in Buffer.

```
discover → score → dedupe → rights gate → headline + commentary → ElevenLabs VO → Whisper captions
        → FFmpeg template (1080×1920) → R2 → Buffer DRAFTS → you approve in Buffer → scheduled → metrics → learning
```

| Package | Runs on | Purpose |
|---|---|---|
| `packages/shared` | Node + Workers | types, scoring, dedupe (pHash), rights policy, slot planning, Buffer GraphQL client, reconcile logic |
| `packages/pipeline` | GitHub Actions / local | `toaster` CLI: discovery adapters, LLM scoring + copy, TTS, captions, renderer, R2 upload, Buffer drafts, sync, learn |
| `packages/worker` | Cloudflare Workers + D1 + R2 | control-plane API, 30-min Buffer approval poller, metrics/learning cron, weekly dispatch |
| `template/` | – | `template.json` layout + Bangers font (OFL) |
| `assets/brand/` | – | approved brand files go here (placeholders generated until then) |

- Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Setup & operations: [docs/RUNBOOK.md](docs/RUNBOOK.md)
- Footage rights: [docs/RIGHTS_POLICY.md](docs/RIGHTS_POLICY.md)
- Footage sources evaluation (what can and cannot be automated): [docs/SOURCES.md](docs/SOURCES.md)
- Brand files needed: [assets/brand/README.md](assets/brand/README.md)

## Quick start
```bash
npm ci && npm run build && npm test
npm run brand:generate                 # placeholder mascot / burst / box (python3 + Pillow)
npm run toaster -- demo --offline      # renders work/demo/demo_final.mp4 with FFmpeg only
npm run toaster -- demo                # + ElevenLabs VO, Whisper captions, LLM copy (needs keys)
```

## Guarantees
- Nothing is published without approval: `BufferClient.createVideoPost` refuses `shareNow`/`shareNext` and refuses non-draft posts (publish guard, tested). Every post is a **draft** (or a Team-plan approval request).
- Nothing is rendered outside the two documented paths: `productionBasis()` returns `cleared`, `review` or null; `review` is policy-gated (`TRANSFORMATION_REVIEW`, `MAX_COPYRIGHT_RISK`) and always labelled.
- YouTube and TikTok approvals are tracked independently. A rejected TikTok draft never invalidates an approved YouTube draft.
- A draft counts as rejected only after Buffer reports "not found" on two polls at least 10 minutes apart; transport errors never change state.
- Draft creation is idempotent (Buffer is checked for a post already at that channel + instant before every create/retry).
- Approved drafts are pinned back to their planned slot and the returned `dueAt` is verified.
- The weekly readiness report (`toaster report`, Worker `/weeks/next/report`) never claims completion unless all 42 slots have live drafts; `run-weekly` exits 1 and raises an alert otherwise.

## Footage sourcing – two labelled paths
- **Cleared** (explicit basis + evidence): Pixabay, Pexels, Internet Archive PD/CC0/CC BY, YouTube CC BY with low provenance risk, creator permission, paid license.
- **Transformation review** (no license on file; the viral path: YouTube virals found without a key or handles across two timeframes – all-time hashtag Shorts shelves and upload-date-filtered search ranked by views per hour –, Reddit top-of-day/week feeds incl. the TikTok mirror subs, optional curated TikTok creators): rendered with real comedic edits (freeze-frame, punch-in zoom at the detected peak, slow-mo replay, reaction sticker, captions, optional original commentary), credited (creator, source link, edit summary, contact e-mail) and drafted in Buffer. Review information stays **internal** (readiness report + Buffer tag); approving a draft records the owner's decision (`owner_reviewed`, never "cleared"). `high` copyright-risk footage (broadcast/pro/music) is never produced. See docs/RIGHTS_POLICY.md, docs/SOURCES.md, docs/DEPLOYMENT.md.
