# Footage rights policy

Two separate paths exist. The code never blurs them, and the owner always sees which one a draft is on.

## Path A – explicit reuse basis ("cleared")
`rights_status = cleared` requires a recognised `rights_basis` **and** non-empty `rights_evidence`
(`isCleared()` in `packages/shared/src/rights.ts`, tested). Sources that reach it automatically:

| Source | Basis | Evidence recorded |
|---|---|---|
| Pixabay / Pexels | platform content license | license URL + item URL |
| Internet Archive PD / CC0 / CC BY items | public_domain / cc0 / cc_by | item URL + `licenseurl` |
| YouTube `creativeCommon` with **low provenance risk** | cc_by | API license snapshot + channel id (+ provenance reasons). A CC label is uploader-asserted, so compilation-style uploads are not cleared. |
| Creator permission (`toaster rights:grant`) | written_permission | link to the reply |
| Paid license | licensed | license id / invoice |

## Path B – transformation review (no license on file)
This is the viral path (Reddit, standard-license YouTube). `rights_status = transformation_review`, `rights_basis = null`.

What the pipeline does with it:
1. The LLM scorer assesses **copyright_risk** (`low` self-filmed amateur footage … `high` broadcast/pro/sports/music/
   compilation content). `high` is **never produced** (`blocked_rights`). The maximum allowed risk is configurable
   (`MAX_COPYRIGHT_RISK`, default `medium`). The whole path can be switched off (`TRANSFORMATION_REVIEW=false`).
2. The clip is **transformed**, not re-posted: branded frame, headline, freeze-frame beat, punch-in zoom at the
   detected peak, slow-motion replay, reaction sticker, karaoke captions, original spoken commentary; the original
   audio is muted when the scorer flags commercial music.
3. Attribution to the poster and source link is written into every description.
4. Review information is **internal only**: the weekly readiness report lists every review-path draft (slot,
   headline, source, creator, copyright risk + reasons, Buffer post ids) and the draft carries an internal Buffer tag
   (`BUFFER_TAG_REVIEW_ID`) when configured. Public captions never contain review text (`postText` throws if they would).
5. Every public description credits the creator (name/handle when identifiable), links the source, summarises our
   edits, and gives the contact address for copyright inquiries / credit corrections / removal
   (`theunhingedtoaster@gmail.com`). It claims no license and no fair use for review-path footage; explicit bases
   (CC BY, public domain, Pexels/Pixabay, permission, licensed) are stated when they exist.
6. Nothing is published by the pipeline. If the **owner approves** the draft in Buffer, the candidate becomes
   `rights_status = owner_reviewed`, `rights_basis = owner_transformative_use`, with the Buffer post id + timestamp as
   evidence (approval metadata). This is a *record of the owner's decision*, not a license, and it never becomes
   `cleared`.
7. If the owner deletes the draft, the candidate is `rejected_user` and never re-drafted into that slot.

### What the policy deliberately does **not** do
- It does not call Path-B footage "licensed", "cleared", or "fair use". Fair use is a legal judgement made case by
  case; the readiness report and every draft say so.
- It does not auto-approve replacements or anything else.
- It does not use background music unless it is listed in `assets/music/manifest.json` with a license.
- It does not send outreach messages; `rights:outreach` only drafts them (optional, not the default strategy).
- YouTube virals are fetched with yt-dlp (`ENABLE_YOUTUBE_TRANSFORM`, on by default at the owner's request; set it to
  `false` to switch the YouTube path off). Third-party downloading conflicts with YouTube's Terms of Service even when
  the content license allows reuse; every such clip stays on the transformation-review path (see docs/SOURCES.md).

### Monetisation vs. authorisation
YouTube's reused-content rules concern *monetisation eligibility* (meaningful transformation, commentary, original
value). Copyright *authorisation* is a separate question the owner takes on when approving a Path-B draft. Both are
documented on the draft so the decision is informed.

## Takedowns
If a creator asks for removal: delete the Buffer post or published video, then run
`toaster rights:deny <candidate_id> --reason "creator takedown"`. The candidate is `denied`, is never re-used, and its
pHash blocks re-uploads of the same clip from other sources.
