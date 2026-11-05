# Brand assets

The renderer looks for the **approved** files below first and falls back to generated placeholders in `generated/`.
Status at launch: `mascot.png`, `logo.png` and `wordmark.png` are cut from the channel's real avatar art and are what
the finished videos show; the background is a burst generated from the brand colours (`colors.json`), the headline is
rendered as brush lettering (no box image needed). No placeholder artwork is used in finished videos. The one asset
that is genuinely missing is **music**: `../music/manifest.json` lists only an example entry, so videos ship without a
music bed until the owner drops licensed tracks there (see `../music/README.md`).

## Exact files needed (drop them in this folder with these names)

| File | Spec | Used for |
|---|---|---|
| `mascot.png` | PNG with alpha, ≥ 700×700, angry toaster, facing left or front | Bottom-right bobbing mascot |
| `mascot_shout.png` *(optional)* | Same as above, mouth open | Shown during the commentary line |
| `logo.png` | PNG with alpha, square ≥ 256×256 | Watermark (bottom-left, next to `@theunhingedtoaster`) |
| `headline_box.png` | PNG with alpha, 1000×340 (or same aspect), comic speech burst in red/black/yellow | Headline background |
| `background_loop.mp4` | 1080×1920, 30 fps, 8–15 s seamless loop, H.264, **no audio** | Animated background (replaces the procedurally rotated sunburst) |
| `font.ttf` *(optional)* | Licensed display font if not Bangers | Headline, watermark, captions, commentary |
| `../music/*.mp3` + `../music/manifest.json` | Royalty-free tracks you hold a license for; manifest lists `{file, title, license, source_url}` | Background music (only tracks listed in the manifest are used) |
| `colors.json` *(optional)* | `{ "red": "#…", "black": "#…", "yellow": "#…" }` | Overrides template colours |

Also needed (configuration, not files):

- `ELEVENLABS_VOICE_ID` for the approved toaster voice (otherwise the first energetic voice in the account is used).
- Confirmation of the exact handle text for the watermark (default `@theunhingedtoaster`).

Regenerate placeholders with `npm run brand:generate` (requires Python 3 + Pillow).

## Current status (iteration 5)
The channel's real avatar art (`channel_avatar_source.png`, pulled from the connected YouTube channel) now drives the
branding: `mascot.png` (round badge of the toaster), `logo.png` (round badge of the full avatar), `wordmark.png`
("THE UNHINGED TOASTER" title cut from the avatar, play button removed), `colors.json`, and the generated burst
background in the same black/red/yellow style. Still welcome if you have them: a transparent-background mascot
(no badge ring), `mascot_shout.png`, and `background_loop.mp4`.
