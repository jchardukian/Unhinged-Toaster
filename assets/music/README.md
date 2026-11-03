# Background music

Only tracks listed in `manifest.json` **with a license field** are ever mixed in. The bed is quiet (10 % volume),
fades in/out, and is ducked further while the toaster speaks. The LLM director turns music off for clips whose own
audio is the joke (`music: "none"`); `MUSIC_DEFAULT=always|never` overrides.

## Recommended source: YouTube Audio Library (free, no attribution, monetisation-safe on YouTube)
1. YouTube Studio → Audio Library → Music. Filter: Genre *Comedy* / *Funk* / *Children's*, Mood *Funky* / *Happy* /
   *Bright*, Attribution *not required*. Good starting picks: "Sneaky Snitch"-style comedy cues, light ukulele, funky bass.
2. Download 6–10 tracks (MP3) into this folder.
3. Add each to `manifest.json`:
   ```json
   { "file": "Funky_Chunk.mp3", "title": "Funky Chunk", "license": "YouTube Audio Library – free to use, no attribution",
     "source_url": "https://studio.youtube.com/.../music", "moods": ["people_fails", "funny_animals", "unbelievable", "wholesome_reactions"] }
   ```
4. Commit. The pipeline picks a track whose `moods` include the clip's category.

Note on TikTok: the Audio Library license covers use in your own videos; it is not TikTok's in-app Commercial Music
Library. TikTok may still flag some tracks for business accounts. If that happens, set `MUSIC_DEFAULT=never` for a
while or use TikTok's in-app sounds manually for those posts.
