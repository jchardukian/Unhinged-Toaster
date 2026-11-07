import { CONTENT_FORMATS, type ContentFormat, type Production, type ScheduledPost } from './types.js';

/**
 * Per-format performance for the pilot comparison (ai_dog_comedy vs real_dog_ranking vs general_viral).
 * Uses what Buffer exposes on each post (views, likes, comments, shares) normalised by age and by 1k views, and the
 * metered production cost per video. Retention metrics are not available from Buffer (YouTube Analytics API, later).
 * Rule from the review: a single viral outlier must not decide, so the median views/hour is reported next to the mean.
 */
export interface FormatStats {
  format: ContentFormat; videos: number; posts_sent: number; posts_measured: number;
  avg_cost_usd: number | null; mean_views_per_hour: number | null; median_views_per_hour: number | null;
  likes_per_1k: number | null; comments_per_1k: number | null; shares_per_1k: number | null; total_views: number;
}

export function formatPerformance(posts: ScheduledPost[], productions: Production[], now = new Date(), minAgeHours = 24): FormatStats[] {
  const prodFormat = new Map(productions.map((p) => [p.id, p.content_format ?? 'general_viral']));
  return CONTENT_FORMATS.map((format) => {
    const prods = productions.filter((p) => (p.content_format ?? 'general_viral') === format);
    const sent = posts.filter((p) => (p.content_format ?? prodFormat.get(p.production_id) ?? 'general_viral') === format && p.state === 'sent');
    const measured = sent.filter((p) => p.views != null && (now.getTime() - Date.parse(p.slot_at)) / 3600000 >= minAgeHours);
    const vph = measured.map((p) => (p.views ?? 0) / Math.max(1, (now.getTime() - Date.parse(p.slot_at)) / 3600000)).sort((a, b) => a - b);
    const views = measured.reduce((a, p) => a + (p.views ?? 0), 0);
    const per1k = (k: 'likes' | 'comments' | 'shares') => (views > 0 ? round1((measured.reduce((a, p) => a + (p[k] ?? 0), 0) / views) * 1000) : null);
    const costs = prods.map((p) => p.production_cost_usd).filter((c): c is number => c != null);
    return {
      format, videos: prods.length, posts_sent: sent.length, posts_measured: measured.length,
      avg_cost_usd: costs.length ? round1(costs.reduce((a, b) => a + b, 0) / costs.length * 100) / 100 : null,
      mean_views_per_hour: vph.length ? round1(vph.reduce((a, b) => a + b, 0) / vph.length) : null,
      median_views_per_hour: vph.length ? round1(vph[Math.floor((vph.length - 1) / 2)]) : null, // lower median: conservative against one viral outlier
      likes_per_1k: per1k('likes'), comments_per_1k: per1k('comments'), shares_per_1k: per1k('shares'), total_views: views,
    };
  });
}

export function formatPerformanceMarkdown(stats: FormatStats[]): string[] {
  const lines = ['', '**Performance by content format** (sent posts ≥ 24 h old; views/hour mean and median, engagement per 1k views, metered cost per video)', '', '| format | videos | sent | measured | views | views/h mean | views/h median | likes/1k | comments/1k | shares/1k | cost/video |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const s of stats) lines.push(`| ${s.format} | ${s.videos} | ${s.posts_sent} | ${s.posts_measured} | ${s.total_views} | ${s.mean_views_per_hour ?? '-'} | ${s.median_views_per_hour ?? '-'} | ${s.likes_per_1k ?? '-'} | ${s.comments_per_1k ?? '-'} | ${s.shares_per_1k ?? '-'} | ${s.avg_cost_usd != null ? `$${s.avg_cost_usd.toFixed(2)}` : '-'} |`);
  return lines;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
