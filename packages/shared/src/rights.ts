import { CLEARABLE_BASES, type Candidate, type CopyrightRisk, type RightsBasis, type SourcePlatform } from './types.js';

export interface RightsPolicy {
  /** Render + draft footage that has no explicit license as clearly labelled transformation-review candidates. */
  transformationReview: boolean;
  /** Highest copyright risk still allowed into transformation review (default: medium). */
  maxCopyrightRisk?: CopyrightRisk;
}
export const DEFAULT_RIGHTS_POLICY: RightsPolicy = { transformationReview: true, maxCopyrightRisk: 'medium' };

const RISK_RANK: Record<CopyrightRisk, number> = { low: 0, medium: 1, high: 2 };

/** Explicitly cleared: recognised basis AND evidence. The only status that is ever described as "cleared". */
export function isCleared(c: Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence'>): boolean {
  return (
    c.rights_status === 'cleared' &&
    c.rights_basis != null &&
    CLEARABLE_BASES.includes(c.rights_basis) &&
    !!c.rights_evidence && c.rights_evidence.trim().length > 0
  );
}

/**
 * On what basis may this candidate be produced?
 *   'cleared'  explicit license / permission / PD
 *   'review'   transformation review: no explicit license; drafted with a REVIEW label for the owner's decision
 *   null       not producible
 */
export function productionBasis(
  c: Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence' | 'copyright_risk'>,
  policy: RightsPolicy = DEFAULT_RIGHTS_POLICY,
): 'cleared' | 'review' | null {
  if (isCleared(c)) return 'cleared';
  if (c.rights_status === 'owner_reviewed') return 'review';
  if (c.rights_status === 'transformation_review' && policy.transformationReview) {
    const risk = c.copyright_risk ?? 'medium';
    if (RISK_RANK[risk] <= RISK_RANK[policy.maxCopyrightRisk ?? 'medium']) return 'review';
  }
  return null;
}

/** Backwards-compatible boolean used by the pipeline. */
export function canProduce(c: Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence' | 'copyright_risk'>, policy: RightsPolicy = DEFAULT_RIGHTS_POLICY): boolean {
  return productionBasis(c, policy) !== null;
}

/** Recorded when the owner approves a transformation-review draft. Not a license; the owner's decision, with evidence. */
export function ownerReviewedRights(c: Pick<Candidate, 'rights_status'>, evidence: string): Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence'> | null {
  if (c.rights_status !== 'transformation_review' && c.rights_status !== 'owner_reviewed') return null;
  return { rights_status: 'owner_reviewed', rights_basis: 'owner_transformative_use', rights_evidence: evidence };
}

export const DEFAULT_CONTACT_EMAIL = 'theunhingedtoaster@gmail.com';

/**
 * PUBLIC credit block appended to every description. Creator name/handle when identifiable, source URL, what we
 * changed, and the contact address. It deliberately makes no claim of authorisation or fair use.
 */
export function creditText(c: Pick<Candidate, 'author' | 'source_url' | 'rights_basis' | 'source_platform'> & Partial<Pick<Candidate, 'detected_handle' | 'detected_platform' | 'meta_json'>>, opts: { contactEmail?: string; editsSummary?: string } = {}): string {
  const email = opts.contactEmail ?? DEFAULT_CONTACT_EMAIL;
  if (c.source_platform === 'ai_generated' || c.rights_basis === 'ai_generated') {
    return [
      '🤖 This video is AI-generated (synthetic footage created for The Unhinged Toaster). No real dog was filmed.',
      `✂️ Edited by The Unhinged Toaster: ${opts.editsSummary ?? 'comedic sound design, captions and animated visuals'}.`,
      `📩 Questions or removal requests: ${email}`,
    ].join('\n');
  }
  const ranking = rankingClips(c.meta_json);
  if (ranking) {
    const lines = ['🎬 Clips in this ranking:'];
    ranking.forEach((k, i) => lines.push(`  ${ranking.length - i}. ${k.author ? `${k.author} — ` : ''}${k.source_url}${k.license ? ` (${k.license})` : ''}`));
    lines.push(`✂️ Edited by The Unhinged Toaster: ${opts.editsSummary ?? 'ranking, captions, comedic sound design and animated visuals'}.`);
    lines.push(`📩 Copyright inquiries, credit corrections or removal requests: ${email}`);
    return lines.join('\n');
  }
  const who = c.author ? displayHandle(c.author, c.source_platform) : 'original creator (uncredited – contact us to be credited)';
  const visible = c.detected_handle ? `@${c.detected_handle.replace(/^@/, '')}${c.detected_platform ? ` on ${capitalize(c.detected_platform)}` : ''}` : null;
  const lines = [
    visible
      ? `🎬 Original clip: ${visible} (as credited in the footage) — found via ${who}: ${c.source_url}`
      : `🎬 Original clip: ${who} — ${c.source_url}`,
    `✂️ Edited by The Unhinged Toaster: ${opts.editsSummary ?? 'original comedic commentary, cuts, zooms, freeze-frames, captions and animated visuals'}.`,
  ];
  switch (c.rights_basis) {
    case 'cc_by': lines.push('📜 Original footage used under Creative Commons Attribution (CC BY).'); break;
    case 'cc0': case 'public_domain': lines.push('📜 Original footage is public domain.'); break;
    case 'pexels_license': lines.push('📜 Original footage via Pexels (Pexels License).'); break;
    case 'pixabay_license': lines.push('📜 Original footage via Pixabay (Content License).'); break;
    case 'written_permission': lines.push('📜 Original footage used with the creator\'s permission.'); break;
    case 'licensed': lines.push('📜 Original footage licensed.'); break;
    default: break; // no basis claim of any kind for review-path footage
  }
  lines.push(`📩 Copyright inquiries, credit corrections or removal requests: ${email}`);
  return lines.join('\n');
}

/** Clip list stored on a ranking candidate (meta_json.clips). */
export interface RankingClip { candidate_id: string; source_url: string; author: string | null; license: string | null; platform: string }
export function rankingClips(metaJson: string | null | undefined): RankingClip[] | null {
  if (!metaJson) return null;
  try { const m = JSON.parse(metaJson) as { clips?: RankingClip[] }; return Array.isArray(m.clips) && m.clips.length ? m.clips : null; } catch { return null; }
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function displayHandle(author: string, platform: SourcePlatform): string {
  const a = author.trim().replace(/^@/, '');
  if (platform === 'reddit') return `u/${a.replace(/^u\//, '')}`;
  if (platform === 'youtube') return a; // channel title
  if (platform === 'tiktok') return `@${a} on TikTok`;
  return `@${a}`;
}

/** INTERNAL review summary (readiness report / approval metadata). Never placed in a public caption. */
export const REVIEW_BLOCK_START = '⚠️ REVIEW BEFORE APPROVING';
export const REVIEW_BLOCK_END = '— end of review note —';
export function reviewBlock(c: Pick<Candidate, 'author' | 'source_url' | 'source_platform' | 'copyright_risk' | 'copyright_risk_reasons' | 'rights_notes'>): string {
  const reasons = safeList(c.copyright_risk_reasons);
  return [
    REVIEW_BLOCK_START,
    `Reuse basis: NONE on file (transformation review). Source: ${c.source_platform} ${c.source_url}${c.author ? ` by ${c.author}` : ''}.`,
    `Copyright risk: ${c.copyright_risk ?? 'unknown'}${reasons.length ? ` (${reasons.join('; ')})` : ''}.`,
    'The video is transformed (cuts, zooms, freeze, replay, captions, original commentary) but transformation is not a license and does not guarantee fair use.',
    'Approving this draft records YOUR decision to publish it on that basis; this note is removed automatically after approval. Delete the draft to reject it.',
    REVIEW_BLOCK_END,
  ].join('\n');
}
export function stripReviewBlock(text: string): string {
  const start = text.indexOf(REVIEW_BLOCK_START);
  const end = text.indexOf(REVIEW_BLOCK_END);
  if (start < 0 || end < 0) return text;
  return (text.slice(0, start) + text.slice(end + REVIEW_BLOCK_END.length)).replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n').trim();
}
export function hasReviewBlock(text: string | null | undefined): boolean {
  return !!text && text.includes(REVIEW_BLOCK_START);
}
function safeList(json: string | null | undefined): string[] {
  try { const v = JSON.parse(json ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

/** Default rights status for each discovery adapter. Only sources with an explicit license auto-clear. */
export interface RightsMeta {
  license?: string | null;
  provenanceRisk?: 'low' | 'medium' | 'high';
  provenanceReasons?: string[];
  evidenceSuffix?: string;
}

export function initialRights(platform: SourcePlatform, meta: RightsMeta): Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence' | 'rights_notes'> {
  switch (platform) {
    case 'youtube':
      if (meta.license === 'creativeCommon') {
        if (meta.provenanceRisk && meta.provenanceRisk !== 'low') {
          return {
            rights_status: 'unknown', rights_basis: null, rights_evidence: null,
            rights_notes: `CC BY label present but provenance risk ${meta.provenanceRisk}: ${meta.provenanceReasons?.join('; ') ?? ''}. A CC label does not prove the uploader owns the footage; needs manual verification.`,
          };
        }
        return {
          rights_status: 'cleared',
          rights_basis: 'cc_by',
          rights_evidence: `YouTube Data API status.license=creativeCommon (CC BY 3.0), provenance risk low. Snapshot stored at discovery${meta.evidenceSuffix ?? ''}.`,
          rights_notes: 'Attribution required in description. Re-verify license at production time; uploader may change it. CC label is uploader-asserted, not verified ownership.',
        };
      }
      return { rights_status: 'transformation_review', rights_basis: null, rights_evidence: null, rights_notes: 'Standard YouTube license: no reuse license on file. Eligible for transformation review only (owner decides per draft).' };
    case 'internet_archive': {
      const lic = (meta.license ?? '').toLowerCase();
      if (/publicdomain|zero\/1\.0|cc0/.test(lic)) return { rights_status: 'cleared', rights_basis: lic.includes('zero') || lic.includes('cc0') ? 'cc0' : 'public_domain', rights_evidence: `${meta.evidenceSuffix ?? ''} licenseurl=${meta.license}`, rights_notes: 'Internet Archive item license as declared by the uploader/collection.' };
      if (/licenses\/by\/\d/.test(lic)) return { rights_status: 'cleared', rights_basis: 'cc_by', rights_evidence: `${meta.evidenceSuffix ?? ''} licenseurl=${meta.license}`, rights_notes: 'Attribution required.' };
      return { rights_status: 'unknown', rights_basis: null, rights_evidence: null, rights_notes: `Internet Archive license not auto-clearable: ${meta.license ?? 'none'} (NC/ND/SA or missing).` };
    }
    case 'pexels':
      return { rights_status: 'cleared', rights_basis: 'pexels_license', rights_evidence: 'https://www.pexels.com/license/', rights_notes: 'Attribution appreciated, not required.' };
    case 'pixabay':
      return { rights_status: 'cleared', rights_basis: 'pixabay_license', rights_evidence: `https://pixabay.com/service/license-summary/${meta.evidenceSuffix ?? ''}`, rights_notes: 'Pixabay Content License: commercial use OK, no attribution required, must be transformed (we add template/captions/commentary); no unmodified redistribution.' };
    case 'licensed_library':
      return { rights_status: 'cleared', rights_basis: 'licensed', rights_evidence: meta.license ?? 'license id missing', rights_notes: null };
    case 'ai_generated':
      // provider terms disclaim ownership of outputs (Google Gemini API terms: "Google won't claim ownership over that content";
      // Runway terms §4.4: "does not claim ownership of any of your Inputs or Outputs ... does not restrict your commercial use")
      return { rights_status: 'cleared', rights_basis: 'ai_generated', rights_evidence: meta.evidenceSuffix ?? 'ai provider job id missing', rights_notes: 'Synthetic footage generated for this channel; disclosed as AI-generated in the description.' };
    case 'tiktok':
      return { rights_status: 'transformation_review', rights_basis: null, rights_evidence: null, rights_notes: 'TikTok user upload, no reuse license on file. Eligible for transformation review only (owner decides per draft). Creator handle credited.' };
    case 'reddit':
      return { rights_status: 'transformation_review', rights_basis: null, rights_evidence: null, rights_notes: 'User-generated, no reuse license on file. Eligible for transformation review only (owner decides per draft). Attribution to the poster is always included.' };
    case 'manual':
    default:
      return { rights_status: 'unknown', rights_basis: null, rights_evidence: null, rights_notes: null };
  }
}

/** Attribution line printed in every post description. */
export function attributionText(c: Pick<Candidate, 'author' | 'source_url' | 'rights_basis' | 'source_platform'>): string {
  const who = c.author ? `@${c.author.replace(/^@/, '')}` : 'the original creator';
  switch (c.rights_basis) {
    case 'cc_by':
      return `Original video by ${who} (${c.source_url}), used under Creative Commons Attribution (CC BY 3.0). Edited: cropped, captioned, commentary added.`;
    case 'written_permission':
      return `Original video by ${who} (${c.source_url}), used with permission.`;
    case 'owner_transformative_use':
      return `Original clip by ${who} (${c.source_url}). Edits, captions and commentary by The Unhinged Toaster.`;
    case 'licensed':
      return `Original video by ${who}, licensed.`;
    case 'pexels_license':
      return `Footage by ${who} via Pexels (${c.source_url}).`;
    case 'pixabay_license':
      return `Footage by ${who} via Pixabay (${c.source_url}).`;
    case 'cc0':
    case 'public_domain':
      return `Footage: ${c.source_url} (public domain).`;
    case 'owned':
      return '';
    default:
      return `Original clip by ${who} (${c.source_url}). Edits, captions and commentary by The Unhinged Toaster.`;
  }
}

/** Permission request we draft for creators (Reddit DM / email / platform comment). Sent by a human or an explicitly enabled outreach job. */
export function permissionRequestMessage(c: Pick<Candidate, 'title' | 'source_url' | 'author'>, channelName = 'The Unhinged Toaster'): string {
  const name = c.author ? `u/${c.author.replace(/^u\//, '')}` : 'there';
  return [
    `Hi ${name}! I run ${channelName}, a comedy clips channel on YouTube Shorts and TikTok.`,
    `I loved your video "${c.title}" (${c.source_url}) and would like to feature it in a captioned short with full credit to you in the on-screen watermark and the description, linking back to your original post.`,
    `Would you be OK with that? A simple "yes" reply is enough, and I will keep this message as a record of your permission. If you would rather I didn't, no problem at all. Thanks!`,
  ].join('\n\n');
}

export function describeBasis(b: RightsBasis | null): string {
  switch (b) {
    case 'cc_by': return 'Creative Commons Attribution';
    case 'cc0': return 'CC0 / public domain dedication';
    case 'public_domain': return 'Public domain';
    case 'pexels_license': return 'Pexels license';
    case 'pixabay_license': return 'Pixabay content license';
    case 'written_permission': return 'Written permission from creator';
    case 'licensed': return 'Paid license';
    case 'owned': return 'Owned footage';
    case 'owner_transformative_use': return 'Owner-approved transformative use (no license)';
    default: return 'No basis recorded';
  }
}
