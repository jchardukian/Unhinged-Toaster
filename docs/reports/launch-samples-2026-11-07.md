# Launch samples (2026-11-07) — three finished Shorts, QC and reuse assessments

Produced from Reddit footage with the full pipeline (text-only commentary, no ElevenLabs call), animated border, QC and
fair-use assessment. Rendered in the cloud sandbox (local files; public URLs come from the Worker when the branch runs
on GitHub Actions). Discovery 108 candidates → scored 40 (31 passed) → 9 rejected for length (87–260 s), 2 for 360p/480p
sources, 17 usable at 720p → 3 rendered in 9 min 10 s for $0.074 total API spend.

| # | headline | source (poster) | dur | QC | hook/payoff/ent/comm/story/edit | fair-use verdict | why |
|---|---|---|---|---|---|---|---|
| 1 | NASTY NOSE WAXING PRANK! | r/Unexpected waxing_your_nose (u/Remurix); Instagram watermark @aram.noir13 → credited | 29.3 s | 7.6 pass | 8/7/8/7/8/7, no defects | uncertain | risk rated medium ("poster may not be the filmer"); foreign Instagram watermark: poster probably not the creator |
| 2 | FROGS IN LOVE?! | r/funnyvideos frogs_accidentally_kiss (u/Mintangah17) | 19.3 s | 7.2 pass | 8/7/8/6/7/7, no defects | uncertain | risk rated medium ("poster may not be the filmer; identifiable third parties are the joke") |
| 3 | DANCE DISASTER UNLOCKED | r/Unexpected yo_wtf (u/hollow_hideous_soul) | 28.7 s | 7.2 pass | 8/7/8/6/7/8, no defects | uncertain | risk rated medium ("watermark from another platform; poster may not be the filmer") |

Every assessment: transformation FOR (original commentary line + headline + freeze/punch-in/replay/captions), amount
neutral (whole short clip), music FOR (none flagged), people FOR (no private-person flags), market effect recorded as an
assumption. None is a documented licence. With the default policy (UNATTENDED_FAIR_USE_MAX_RISK=low) all three would be
HELD for the owner, not scheduled; with UNATTENDED_FAIR_USE_MAX_RISK=medium, #2 and #3 would become `supportable` and
#1 would stay `uncertain` because of the foreign watermark.

Existing 20 Buffer drafts (10 videos from the 2026-11-06 batch) re-checked with the strengthened QC: all pass,
scores 6.8–7.6 (strongest: CATASTROPHIC CAT TUMBLE 7.6, WHO LOOKS RUSSIAN?! 7.6, then four at 7.4).

Buffer scheduling probe (CI run 110, real account, guarded autopilot path): YouTube and TikTok posts created with
status `scheduled` for 2027-12-12, read back as scheduled, deleted within seconds (read-back null). Nothing published.
