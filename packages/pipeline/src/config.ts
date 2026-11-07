import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load .env from repo root if present (no dotenv dependency). Existing env wins. */
export function loadDotenv(file = path.join(repoRoot(), '.env')): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    const hash = v.indexOf(' #');
    if (hash >= 0) v = v.slice(0, hash).trim();
    v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

/** The Worker URL the "Deploy control plane" workflow commits to config/worker-url.txt, so no variable needs to be set by hand. */
export function deployedWorkerUrl(root: string): string | undefined {
  const f = path.join(root, 'config', 'worker-url.txt');
  if (!fs.existsSync(f)) return undefined;
  const u = fs.readFileSync(f, 'utf8').trim();
  return /^https:\/\/[a-z0-9.-]+\.workers\.dev$/.test(u) ? u : undefined;
}

export function repoRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // packages/pipeline/src or packages/pipeline/dist -> repo root
  return path.resolve(here, '..', '..', '..');
}

export interface Config {
  llmProvider: 'openai' | 'anthropic';
  llmModel: string;
  visionOcrModel: string;
  openaiKey: string | undefined;
  anthropicKey: string | undefined;
  transcribeModel: string;
  elevenKey: string | undefined;
  elevenVoiceId: string | undefined;
  elevenModelId: string;
  bufferKey: string | undefined;
  bufferOrgId: string;
  bufferYoutubeChannelId: string;
  bufferTiktokChannelId: string;
  tz: string;
  publishSlots: string;
  approvalMode: 'draft' | 'needs_approval';
  bufferTagReviewId: string | undefined;
  bufferTagClearedId: string | undefined;
  contactEmail: string;
  commentaryDefault: 'auto' | 'always' | 'never';
  allowLowQuality: boolean;
  musicDefault: 'auto' | 'always' | 'never';
  stickers: boolean;
  tiktokAccounts: string[];
  ytdlpCookiesB64: string | undefined;
  ytdlpYoutubeClients: string;
  /** Timeframes the credential-free YouTube viral adapter scans: today / week / month (gaining traction) and alltime (proven). */
  youtubeViralWindows: ('today' | 'week' | 'month' | 'alltime')[];
  /** Reddit top-of windows: day (trending now) and week / month (proven). */
  redditWindows: ('day' | 'week' | 'month')[];
  youtubeKey: string | undefined;
  enableYoutubeCc: boolean;
  enableYoutubeTransform: boolean;
  transformationReview: boolean;
  maxCopyrightRisk: 'low' | 'medium' | 'high';
  sources: string | undefined;
  reddit: { clientId?: string; clientSecret?: string; username?: string; password?: string; userAgent: string };
  pexelsKey: string | undefined;
  pixabayKey: string | undefined;
  r2: { accountId?: string; accessKeyId?: string; secretAccessKey?: string; bucket: string; publicBaseUrl?: string };
  apiUrl: string | undefined;
  apiToken: string | undefined;
  /** Unattended publishing (autopilot): off unless UNATTENDED_PUBLISHING=true AND the owner's exact phrase is set. */
  unattended: boolean;
  unattendedAuthorization: string | undefined;
  emergencyStop: boolean;
  unattendedMinQc: number;
  /** keep drafting transformation-review videos for optional owner approval while autopilot runs (default false) */
  unattendedReviewDrafts: boolean;
  workDir: string;
  assetsDir: string;
  templateDir: string;
}

export function loadConfig(): Config {
  loadDotenv();
  const e = process.env;
  const root = repoRoot();
  return {
    llmProvider: (e.LLM_PROVIDER === 'anthropic' ? 'anthropic' : 'openai'),
    llmModel: e.LLM_MODEL?.trim() || (e.LLM_PROVIDER === 'anthropic' ? 'claude-haiku-5-5' : 'gpt-4o-mini'),
    visionOcrModel: e.VISION_OCR_MODEL?.trim() || (e.LLM_PROVIDER === 'anthropic' ? 'claude-sonnet-5-5' : 'gpt-4o'),
    openaiKey: e.OPENAI_API_KEY,
    anthropicKey: e.ANTHROPIC_API_KEY,
    transcribeModel: e.TRANSCRIBE_MODEL ?? 'whisper-1',
    elevenKey: e.ELEVENLABS_API_KEY,
    elevenVoiceId: e.ELEVENLABS_VOICE_ID || undefined,
    elevenModelId: e.ELEVENLABS_MODEL_ID ?? 'eleven_turbo_v2_5',
    bufferKey: e.BUFFER_API_KEY,
    bufferOrgId: e.BUFFER_ORGANIZATION_ID ?? '6abaf3c8c5df6d1c7b1c9d3c',
    bufferYoutubeChannelId: e.BUFFER_YOUTUBE_CHANNEL_ID ?? '6ae95257e29c69a17143de1d',
    bufferTiktokChannelId: e.BUFFER_TIKTOK_CHANNEL_ID ?? '6ae9500ee29c69a17143c263',
    tz: e.BUFFER_TIMEZONE ?? 'America/Chicago',
    publishSlots: e.PUBLISH_SLOTS ?? '11:00,15:00,19:00',
    approvalMode: (e.BUFFER_APPROVAL_MODE as 'draft' | 'needs_approval') ?? 'draft',
    bufferTagReviewId: e.BUFFER_TAG_REVIEW_ID || undefined,
    bufferTagClearedId: e.BUFFER_TAG_CLEARED_ID || undefined,
    contactEmail: e.CONTACT_EMAIL || 'theunhingedtoaster@gmail.com',
    allowLowQuality: e.ALLOW_LOW_QUALITY === 'true',
    stickers: e.STICKERS === 'true',
    tiktokAccounts: (e.TIKTOK_ACCOUNTS ?? '').split(',').map((x) => x.trim().replace(/^@/, '')).filter(Boolean),
    ytdlpCookiesB64: e.YTDLP_COOKIES_B64 || undefined,
    ytdlpYoutubeClients: e.YTDLP_YOUTUBE_CLIENTS || '',
    youtubeViralWindows: (e.YOUTUBE_VIRAL_WINDOWS || 'today,week,month,alltime').split(',').map((x) => x.trim()).filter((x): x is 'today' | 'week' | 'month' | 'alltime' => ['today', 'week', 'month', 'alltime'].includes(x)),
    redditWindows: (e.REDDIT_WINDOWS || 'day,week').split(',').map((x) => x.trim()).filter((x): x is 'day' | 'week' | 'month' => ['day', 'week', 'month'].includes(x)),
    musicDefault: (['auto', 'always', 'never'].includes(e.MUSIC_DEFAULT ?? '') ? e.MUSIC_DEFAULT : 'auto') as 'auto' | 'always' | 'never',
    commentaryDefault: (['auto', 'always', 'never'].includes(e.COMMENTARY_DEFAULT ?? '') ? e.COMMENTARY_DEFAULT : 'auto') as 'auto' | 'always' | 'never',
    youtubeKey: e.YOUTUBE_API_KEY,
    enableYoutubeCc: e.ENABLE_YOUTUBE_CC === 'true',
    enableYoutubeTransform: e.ENABLE_YOUTUBE_TRANSFORM !== 'false',
    transformationReview: e.TRANSFORMATION_REVIEW !== 'false',
    maxCopyrightRisk: (['low', 'medium', 'high'].includes(e.MAX_COPYRIGHT_RISK ?? '') ? e.MAX_COPYRIGHT_RISK : 'medium') as 'low' | 'medium' | 'high',
    sources: e.DISCOVERY_SOURCES || undefined,
    reddit: {
      clientId: e.REDDIT_CLIENT_ID, clientSecret: e.REDDIT_CLIENT_SECRET, username: e.REDDIT_USERNAME, password: e.REDDIT_PASSWORD,
      userAgent: e.REDDIT_USER_AGENT ?? 'unhinged-toaster/0.1',
    },
    pexelsKey: e.PEXELS_API_KEY,
    pixabayKey: e.PIXABAY_API_KEY,
    r2: { accountId: e.R2_ACCOUNT_ID, accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, bucket: e.R2_BUCKET ?? 'toaster-media', publicBaseUrl: e.R2_PUBLIC_BASE_URL },
    apiUrl: e.TOASTER_API_URL || deployedWorkerUrl(root),
    apiToken: e.TOASTER_API_TOKEN,
    unattended: e.UNATTENDED_PUBLISHING === 'true',
    unattendedAuthorization: e.UNATTENDED_AUTHORIZATION,
    emergencyStop: e.EMERGENCY_STOP === 'true',
    unattendedMinQc: Number(e.UNATTENDED_MIN_QC) > 0 ? Number(e.UNATTENDED_MIN_QC) : 7,
    unattendedReviewDrafts: e.UNATTENDED_REVIEW_DRAFTS === 'true',
    workDir: path.resolve(root, e.WORK_DIR ?? 'work'),
    assetsDir: path.join(root, 'assets'),
    templateDir: path.join(root, 'template'),
  };
}

export const log = {
  info: (...a: unknown[]) => console.log(new Date().toISOString(), '[info]', ...a),
  warn: (...a: unknown[]) => console.warn(new Date().toISOString(), '[warn]', ...a),
  error: (...a: unknown[]) => console.error(new Date().toISOString(), '[error]', ...a),
};
