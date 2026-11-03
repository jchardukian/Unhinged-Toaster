# Footage sources – evaluation (researched 2026-11-03)

Requirement: 21 entertaining, *proven-viral* shorts per week, fully automated, commercially redistributable, no
creator outreach by the owner. Every source below was evaluated against that bar. Prices are public list prices
found during research; nothing was purchased.

| Source | Catalog / relevance | Viral entertainment footage | Commercial redistribution rights | Automated access | Monthly cost at 21 clips/week (~90/month) | Extra permission needed | Verdict |
|---|---|---|---|---|---|---|---|
| **Jukin Licensing** (FailArmy, People Are Awesome; now part of Trusted Media Brands) | Millions of UGC clips; exactly our categories | **Yes** – the industry standard | Yes, per-clip license (self-serve tiers launched 2020: $49 watermarked, **$99 monetised single channel**, $299 unlimited channels; current rates may differ) | **No public API.** Web licensing portal; enterprise/API deals are sales-led | ≈ $9k/month at the $99 tier (≈ $27k at $299) | Commercial agreement; exclusivity is on the *creator* side, not ours | Best fit for content, **blocked on cost + no API** |
| **ViralHog** | Hundreds of thousands of UGC viral clips | **Yes** | Yes, per-clip; buyer rate card not public (creator side is 50 % rev-share) | No public API; request-based licensing | Unknown, sales-led | Commercial agreement | Same as Jukin |
| **Newsflare** | 60k+ contributors, UGC | Mixed (news-heavy, some fails/animals) | Yes: Growing Publisher **$230/clip or $2,200 per 10** (≤ 3 owned channels), Established **$355 / $3,200 per 10** | No public API (B2B feeds via AP Video Hub / Reuters Connect) | ≈ $20k/month | Commercial agreement | Too expensive, no API |
| **Collab Clips** (Collab Inc.) | 235k clips, built for reaction/commentary creators, creators credited + paid | **Yes** | Yes, per-clip licensing through their platform | No public API found | Not published | Account + agreement | Most "creator-shaped" option; needs a sales conversation |
| **Storyful Video** | UGC news verification + marketplace | Low (news) | Yes | No API | Enterprise | Agreement | Not relevant |
| **Pixabay Videos** | ~100k+ clips; "funny dog/cat", slow-motion, stunts; stock-style | Weak – cute/amusing, not *fails that went viral* | **Yes** (Pixabay Content License: commercial use, no attribution, must be transformed; our template/captions/commentary qualify) | **Yes**, free API (100 req/min), direct MP4 URLs, view/like/download counts | $0 | None | **Implemented** (auto-cleared) |
| **Pexels Videos** | Similar to Pixabay, portrait clips available | Weak (stock) | Yes (Pexels License) | Yes, free API | $0 | None | **Implemented** (auto-cleared) |
| **Internet Archive** | Public-domain / CC0 / CC BY films; short items are rare | Weak and dated (vintage slapstick, home movies) | Yes for PD/CC0/CC BY items (uploader-declared) | Yes, keyless search + metadata API, direct downloads; intermittent 429/5xx | $0 | None | **Implemented** (auto-cleared, short items only; low yield) |
| **YouTube (Creative Commons filter)** | Large; many "CC BY" uploads are re-uploads/compilations | Medium | CC BY permits reuse with attribution **only if the uploader actually owns the footage** – the label is uploader-asserted. Downloading via yt-dlp also conflicts with YouTube ToS | Yes (Data API) + yt-dlp | $0 | Provenance verification | **Implemented but opt-in** (`ENABLE_YOUTUBE_CC=true`); provenance heuristics reject compilation-style uploads; residual risk documented |
| **Reddit** | The best firehose of fresh viral clips | **Yes** | **No** – user content; needs the poster's permission for each clip | Yes (OAuth API) for discovery | $0 | Per-clip creator permission → recurring human work | Discovery only; disabled from the default sources |
| **Vimeo (CC filter)** | Moderate; CC filtering exists in UI, API download access unverified | Low | CC BY (uploader-asserted) | Unverified | $0 | Provenance | Not implemented |
| Storyblocks / Pond5 / Getty / Artlist | Large stock catalogs, some have partner APIs | None (stock) | Yes (subscription) | Enterprise APIs | $30–$300+/month | Account | Not relevant for *viral* |

## Conclusion (precise blocker)

- **No free or API-accessible source supplies proven-viral entertainment footage with redistribution rights.** The
  sources that do have that footage (Jukin, ViralHog, Collab Clips, Newsflare) are sales-led, have no self-serve API,
  and cost roughly **$9k–$27k per month** at list prices for 90 clips. That is a commercial decision, not a code change.
- What *is* fully automated today: Pixabay + Pexels + Internet Archive discovery → scoring → render → drafts. Expect
  "amusing stock" (animals, slow-motion, stunts), not viral fails. The LLM scorer's `brand_fit`/`surprise` rubric and
  the 62-point threshold will reject most of it, so the weekly readiness report will usually show a shortage with
  reason `score_below_threshold` or `not enough eligible footage`. That report is the honest signal; the pipeline does
  not pad the week with low-quality clips.
- YouTube CC BY is the only free source with real viral material. It is implemented with provenance heuristics and is
  **off by default** because (a) the CC label does not prove ownership and (b) third-party downloading conflicts
  with YouTube's Terms of Service. Enabling it is an owner decision (`ENABLE_YOUTUBE_CC=true`).

## Recommended path to 21/week without recurring owner work

1. Sign one clip-licensing agreement (Collab Clips or Jukin are the best content fits). Ask for API or bulk-export
   access; both have programmatic delivery for larger partners. Budget ≈ $100–$300 per clip at list, less on a bundle.
2. Point the `licensed_library` adapter at their feed (one adapter file, same Candidate shape, rights_basis `licensed`
   with the license id as evidence). Everything downstream already works.
3. Keep Pixabay/Pexels/IA as filler for the "funny animals" pillar.
