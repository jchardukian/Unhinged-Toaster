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

## Update (iteration 3): viral-first with transformation review

The owner chose to keep the original model: previously viral footage, meaningfully transformed, with a per-draft
owner decision for footage that has no license on file. Implemented as a separate, labelled path
(`docs/RIGHTS_POLICY.md`, Path B):

| Source | Default | Rights path | Automated download |
|---|---|---|---|
| **YouTube virals, no key and no creator handles** (`youtube_viral`) | **on by default** (`ENABLE_YOUTUBE_TRANSFORM`, default true) | transformation review (CC BY + low provenance → cleared) | yes via yt-dlp (needs `pip install "yt-dlp[default]"`: YouTube's "n" challenge is solved with the pipeline's own Node runtime). Two timeframes, `YOUTUBE_VIRAL_WINDOWS=today,week,month,alltime`: **alltime** reads the hashtag Shorts shelves (`youtube.com/hashtag/<tag>/shorts` for funny, fails, instantkarma, funnyanimals, funnycats, funnydogs, unexpected, waitforit, wholesome, heartwarming), which list the most-viewed Shorts per tag (21M–336M views in the probe); **today / week / month** use YouTube search with the upload-date + under-4-min + sort-by-views filters and rank by views per hour since upload, so clips that just went viral surface. Flat rows are enriched with the Data API (`YOUTUBE_API_KEY`, free, no bot wall) or, without a key, batched yt-dlp metadata; titles in non-Latin scripts and compilation-style channels are filtered. **GitHub-hosted runners are bot-walled by YouTube's player API** (CI probe: shelves 18/18 OK, per-video metadata 0/40, so no downloads): the pipeline skips YouTube there. Cookies and self-hosted runners were evaluated and are **not part of the launch** (owner decision); YouTube stays discovery-only until a fetch path is approved. |
| Reddit top-of-day and top-of-week (14 subreddits incl. the TikTok mirrors r/TikTokCringe, r/funnyvideos; `REDDIT_WINDOWS=day,week`) | **on by default** – OAuth API when a free script app is configured, otherwise the public Atom feeds (`/r/<sub>/top/.rss`, no credentials; verified from a datacenter IP) | transformation review | yes: v.redd.it DASH manifest → highest rendition (`CMAF_1080/720.mp4`) + `CMAF_AUDIO_128.mp4`, merged. Note: Reddit's CDN ladder tops out at 720p for many posts, so Reddit footage is often 720p-class even when the original was sharper. TikTok re-posts usually have the watermark stripped (3 of 3 probed), so the two-frame watermark reader rarely recovers the original handle. |
| **TikTok creator accounts** (`TIKTOK_ACCOUNTS`, optional curated original creators) | on when configured | transformation review | yes via yt-dlp: native 1080×1920 with real views / likes / comments / reposts (verified from a datacenter IP). **There is no server-side TikTok discovery without handles**: yt-dlp marks its tag / sound extractors "currently broken", search and for-you pages are unsupported, the tag / discover / explore HTML ships no video items (loaded by signed XHR), and the Creative Center trend API answers "no permission". |
| YouTube most-popular chart (Comedy / Pets / Entertainment, Shorts-length) with `YOUTUBE_API_KEY` | on when the key exists | transformation review (CC BY + low provenance → cleared) | yt-dlp as above. If a runner IP is bot-walled ("sign in to confirm you're not a bot": seen for the ios/web/tv player clients, not for yt-dlp's default set), set `YTDLP_COOKIES_B64` (your exported browser cookies) or pin `YTDLP_YOUTUBE_CLIENTS`. The `Sourcing probe` workflow (`discover --dry-run --fetch 1`) proves the fetch path on the real runner. |
| YouTube CC search | opt-in `ENABLE_YOUTUBE_CC=true` | cleared only with low provenance risk | yt-dlp |
| Pixabay / Pexels / Internet Archive | on when keys exist | cleared | yes |
| **Viral funny-dog shortlist** (`dog-shortlist` command / "Dog shortlist" workflow; discovery only) | manual | unchanged: standard licence → transformation review, CC BY + low provenance → cleared, high risk → blocked; a view count is never treated as permission | **YouTube**: 24 dog hashtag Shorts shelves (no key, no cookies) → exact view count / duration / upload date through yt-dlp's `web_embedded` player client with `--ignore-no-formats-error` (answers from datacenter IPs where the default clients are bot-walled; no media formats, so it is metadata-only) → **≥ 1,000,000 verified views** → three real frames from the thumbnail CDN (`i.ytimg.com/vi/<id>/oar1..3.jpg`, 1080×1920 at 25/50/75 %) tiled for the vision rubric (no download). **TikTok**: creator pages via yt-dlp give exact views; handles come from `TIKTOK_ACCOUNTS`, the workflow input, and TikTok watermarks read in the YouTube frames. Tag / search / discover pages and the challenge item API still return no items from a server (re-checked 2026-11-07). **Reddit**: 10 dog communities via RSS; Reddit exposes no view counts, so Reddit rows are listed but never counted as "1M+ verified". Scoring: dog-comedy rubric (funny, clear payoff, clarity, originality, footage quality, single clip, AI-fake check) with gpt-4o-mini (~$0.003 per clip with frames); duplicates removed by URL, frame perceptual hash and title+length. Output `work/dog-shortlist.md/json`; nothing is stored or drafted. |

Ordering is viral-first (final score), so Path-B clips fill the week before stock-style fillers. Every Path-B draft is
labelled in Buffer, the readiness report counts them separately, and `high` copyright-risk footage is never produced.

## Conclusion from the licensing research (still true)

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
