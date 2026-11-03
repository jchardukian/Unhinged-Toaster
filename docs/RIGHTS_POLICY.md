# Footage rights policy

The pipeline never renders, uploads or drafts a clip unless its candidate row is `rights_status = cleared` **and**
has a recognised `rights_basis` **and** a non-empty `rights_evidence`. This is enforced in code
(`packages/shared/src/rights.ts` → `canProduce`) and tested. There is no override flag.

## What each source legitimately gives us

| Source | Default status | Basis | How it is cleared |
|---|---|---|---|
| YouTube Data API, `status.license = creativeCommon` | `cleared` | `cc_by` | License is re-checked from the `videos.list` response at discovery; attribution is written into every description. **Caveat:** fetching the file needs `yt-dlp`, which YouTube's Terms of Service do not permit for third-party downloading even of CC BY videos. Treat this source as "license-clean, ToS-grey" and decide whether to enable it. |
| Reddit (`v.redd.it` videos) | `unknown` | `written_permission` after outreach | The pipeline drafts a permission request (`toaster rights:outreach`). A human sends it (or an outreach job you explicitly enable). When the creator says yes, run `toaster rights:grant <id> --basis written_permission --evidence <link to the reply>`. Reddit's own API terms also prohibit using Reddit content to train models and require attribution; we store author + permalink for every clip. |
| Pexels / Pixabay | `cleared` | `pexels_license` / `pixabay_license` | Platform license permits reuse. Mostly stock footage, so low viral value; used as filler. |
| Paid clip libraries (Jukin/ViralHog, Newsflare, Storyful) | `cleared` | `licensed` | Only when a license id / invoice is stored as evidence. Adapter stub `licensed_library`; no integration yet. |
| Our own footage | `cleared` | `owned` | – |

## What we deliberately do **not** do

- We do not download TikTok, Instagram or standard-license YouTube videos. "It went viral" is not a license.
- We do not claim fair use automatically. Commentary + captions may or may not qualify; that is a legal judgement, not a pipeline flag.
- We do not use background music unless it is listed in `assets/music/manifest.json` with a license.
- We do not send outreach messages automatically. `rights:outreach` only drafts them.

## Attribution

`attributionText()` produces the credit line stored on the candidate and appended to every post description, e.g.
`Original video by @creator (https://...), used under Creative Commons Attribution (CC BY 3.0). Edited: cropped, captioned, commentary added.`

## Takedowns

If a creator asks for removal: delete the Buffer post (or the published video), then run
`toaster rights:deny <candidate_id> --reason "creator takedown"` so the candidate is never re-used, and its pHash
blocks re-uploads of the same clip from other sources.
