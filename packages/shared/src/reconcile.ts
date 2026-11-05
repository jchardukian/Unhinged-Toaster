import type { BufferPost } from './buffer.js';
import type { BufferPostState, ScheduledPost } from './types.js';

/**
 * Pure reconciliation of our ScheduledPost against what Buffer reports.
 *  - draft disappeared  -> user rejected it (deleted in Buffer)      => 'deleted'  (replacement needed)
 *  - draft -> scheduled  -> user approved it                          => 'scheduled' (we pin dueAt to the slot)
 *  - scheduled -> sent   -> published                                 => 'sent'
 *  - error               -> Buffer failed to publish                  => 'error'
 */
export function reconcilePost(
  ours: Pick<ScheduledPost, 'state' | 'slot_at'>,
  theirs: BufferPost | null,
): { state: BufferPostState; approved: boolean; rejected: boolean; published: boolean; needsReschedule: boolean; error: string | null } {
  if (!theirs) {
    const rejected = ours.state === 'draft' || ours.state === 'needs_approval';
    return { state: 'deleted', approved: false, rejected, published: false, needsReschedule: false, error: rejected ? null : 'post vanished after approval' };
  }
  const s = (theirs.status ?? '').toLowerCase() as BufferPostState;
  const wasPending = ours.state === 'draft' || ours.state === 'needs_approval';
  const approved = wasPending && (s === 'scheduled' || s === 'sending' || s === 'sent');
  const published = s === 'sent';
  const needsReschedule = approved && s === 'scheduled' && !!theirs.dueAt && Math.abs(Date.parse(theirs.dueAt) - Date.parse(ours.slot_at)) > 60_000;
  const error = s === 'error' ? theirs.error?.message ?? 'Buffer reported an error' : null;
  return { state: s, approved, rejected: false, published, needsReschedule, error };
}
