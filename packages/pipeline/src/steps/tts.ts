import fs from 'node:fs';
import { log, type Config } from '../config.js';
import { recordTts } from '../usage.js';
import { assertBudget, assertOpen, fetchWithTimeout, isFatal, recordFailure, recordSuccess, TIMEOUTS } from '../guard.js';

/**
 * ElevenLabs text-to-speech for the toaster's one-line commentary.
 * Returns the mp3 path, or null when ElevenLabs is not configured / fails (the video then ships without VO).
 */
export async function synthesiseCommentary(cfg: Config, text: string, out: string): Promise<string | null> {
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'audio/mpeg' };
  if (cfg.elevenKey) headers['xi-api-key'] = cfg.elevenKey;
  try {
    assertOpen('elevenlabs');
    assertBudget('elevenlabs tts');
    const voiceId = cfg.elevenVoiceId ?? (await pickVoice(headers));
    if (!voiceId) return null;
    const res = await fetchWithTimeout(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        text,
        model_id: cfg.elevenModelId,
        voice_settings: { stability: 0.35, similarity_boost: 0.8, style: 0.75, use_speaker_boost: true },
      }),
    }, TIMEOUTS.ttsMs, 'ElevenLabs TTS');
    if (!res.ok) { const body = (await res.text()).slice(0, 200); const fatal = recordFailure('elevenlabs', res.status, body); throw fatal ?? new Error(`elevenlabs ${res.status}: ${body}`); }
    recordSuccess('elevenlabs');
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    recordTts(text.length);
    return out;
  } catch (e) {
    if (isFatal(e)) throw e; // budget / breaker: stop the run instead of shipping voiceless videos one after another
    log.warn(`TTS failed: ${(e as Error).message}`);
    return null;
  }
}

async function pickVoice(headers: Record<string, string>): Promise<string | null> {
  const res = await fetchWithTimeout('https://api.elevenlabs.io/v1/voices', { headers }, TIMEOUTS.ttsMs, 'ElevenLabs voices');
  if (!res.ok) { const fatal = recordFailure('elevenlabs', res.status, 'voices'); throw fatal ?? new Error(`elevenlabs voices ${res.status}`); }
  const j = (await res.json()) as { voices: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  // Prefer an energetic male voice if labelled; otherwise the first voice.
  const pref = j.voices.find((v) => /energetic|excited|shout|intense/i.test(JSON.stringify(v.labels ?? {})))
    ?? j.voices.find((v) => /^(Brian|Daniel|Callum|Liam|Josh|Adam)$/i.test(v.name))
    ?? j.voices[0];
  if (pref) log.info(`ElevenLabs voice auto-selected: ${pref.name} (${pref.voice_id}); set ELEVENLABS_VOICE_ID to pin it`);
  return pref?.voice_id ?? null;
}
