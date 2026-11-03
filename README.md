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
- Brand files needed: [assets/brand/README.md](assets/brand/README.md)

## Quick start
```bash
npm ci && npm run build && npm test
npm run brand:generate                 # placeholder mascot / burst / box (python3 + Pillow)
npm run toaster -- demo --offline      # renders work/demo/demo_final.mp4 with FFmpeg only
npm run toaster -- demo                # + ElevenLabs VO, Whisper captions, LLM copy (needs keys)
```

## Guarantees
- Nothing is published without approval: every Buffer post is created as a **draft** (`saveToDraft: true`).
- Nothing is rendered without rights: `canProduce()` requires `cleared` + basis + evidence. No override.
- Rejected drafts are replaced automatically; approved drafts are pinned to their planned slot.
