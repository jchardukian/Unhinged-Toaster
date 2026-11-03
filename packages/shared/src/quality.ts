/**
 * Source quality gate. Viewers swipe on soft video, so the pipeline requires 1080p-class sources, accepts 720p-class
 * only as a last resort when the week cannot otherwise be filled, and never uses anything lower.
 *
 * "Effective resolution" is the dimension that gets stretched across the 1080-wide canvas:
 *   portrait / square sources -> width (a 1080x1920 Short needs 1080 px wide)
 *   landscape sources         -> height (a 1920x1080 clip fills the 1080 width natively)
 */
export type QualityTier = 'hd' | 'ok' | 'low';

export const QUALITY_THRESHOLDS = { hd: 1080, ok: 720 };

export function qualityTier(width: number | null | undefined, height: number | null | undefined): QualityTier | null {
  if (!width || !height) return null;
  const effective = height >= width ? width : height;
  if (effective >= QUALITY_THRESHOLDS.hd) return 'hd';
  if (effective >= QUALITY_THRESHOLDS.ok) return 'ok';
  return 'low';
}

/** Scale factor the renderer will apply; > 1 means upscaling (we add gentle sharpening above 1.15). */
export function upscaleFactor(width: number, height: number, canvasW = 1080, canvasH = 1920): number {
  const sc = Math.min(canvasW / width, canvasH / height);
  return Math.round(sc * 100) / 100;
}
