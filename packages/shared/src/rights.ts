import { CLEARABLE_BASES, type Candidate, type RightsBasis, type SourcePlatform } from './types.js';

/**
 * Rights policy. The pipeline NEVER renders or drafts a candidate unless `canProduce` is true.
 * We do not infer permission. A candidate is cleared only when it has a recognised basis AND evidence.
 */
export function canProduce(c: Pick<Candidate, 'rights_status' | 'rights_basis' | 'rights_evidence'>): boolean {
  return (
    c.rights_status === 'cleared' &&
    c.rights_basis != null &&
    CLEARABLE_BASES.includes(c.rights_basis) &&
    !!c.rights_evidence && c.rights_evidence.trim().length > 0
  );
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
      return { rights_status: 'unknown', rights_basis: null, rights_evidence: null, rights_notes: 'Standard YouTube license: reuse requires the uploader\'s written permission.' };
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
    case 'reddit':
      return { rights_status: 'unknown', rights_basis: null, rights_evidence: null, rights_notes: 'User-generated. Requires written permission from the original poster (OP) before use.' };
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
      return `Original video by ${who} (${c.source_url}).`;
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
    default: return 'No basis recorded';
  }
}
