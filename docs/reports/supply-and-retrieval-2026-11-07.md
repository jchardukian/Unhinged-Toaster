# Viral footage: retrieval and rights supply measurements (2026-11-07, final sprint)

## Retrieval (technical)
| Where | YouTube metadata | YouTube media | TikTok creator page | Reddit |
|---|---|---|---|---|
| GitHub-hosted runner (CI runs 102, 106) | works (embedded-player client, 20/20) | **blocked**: "Sign in to confirm you're not a bot" for web_embedded, mweb, web and default clients, with and without the bgutil proof-of-origin token provider (0/8 downloads) | **blocked** (empty JSON / "unable to extract secondary user ID") | works (v.redd.it CDN), feeds rate-limited (429) but retried |
| Claude cloud sandbox (this session) | works | player API answers and lists 1080p formats (web_embedded + Node JS runtime); the CDN download is blocked by the sandbox network (502 from the proxy), so no download was completed anywhere outside a browser | works (exact views) | works (feeds 429 from the shared IP) |

Conclusion: no cookie-free, subscription-free path downloads YouTube or TikTok media on GitHub Actions. The block is on
the runner IP range at the player request itself (not a PO-token problem). Reddit footage is retrievable on runners.

## Rights-documented supply of entertaining viral clips
| Source | Measured | Usable for unattended publishing |
|---|---|---|
| YouTube Creative Commons search (8 funny queries, CC filter, 155 results, licence verified via player metadata) | 155 CC-licensed; 13 are 5-60 s; 2 have >= 100k views, both compilations by one 12.9M-sub creator; the rest 20-9,661 views, mostly "try not to laugh" re-uploads (provenance high) | **0** funny single-clip virals |
| Wikimedia Commons + Internet Archive (dog pilot, no keys) | 32 licensed candidates; 0 scored as funny (34-54) | 0 |
| Pexels / Pixabay (free keys not present; earlier survey) | plentiful but generic stock, not comedy | ruled out as a primary strategy by the owner |
| Viral YouTube Shorts with >= 1,000,000 verified views (dog shortlist) | 159 verified, 54 pass the comedy gate | 0 have a documented reuse right (standard licence) |
| Reddit virals (production source of the 20 existing drafts) | retrievable, entertaining, QC-passing | 0 documented rights (transformation review only) |
| Licensing marketplaces (ViralHog, Newsflare, Jukin, Storyful) | ViralHog: quote by e-mail, price "varies", no API; the others could not be read from this environment | not automatable; price unknown |
| Creator outreach / opt-in | forbidden by the owner | n/a |

## End-to-end production run (sandbox, Reddit footage, text commentary, no ElevenLabs)
discover 15 -> score 5/5 -> download 5 (1 rejected 360p) -> render #1 FAILED QC (caption word shown 5.6 s) -> replacement
render #2 PASSED QC 7.7 (hook 8, payoff 7, entertainment 8, no defects, brand visible) -> 1080x1920, 24.8 s, 24.8 MB.
Runtime 5 min 20 s, API spend $0.05. Rights: transformation review (Reddit) -> the unattended gate would log `skip`.
