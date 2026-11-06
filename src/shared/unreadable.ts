import type { ExtractionFailureReason } from './api';

/**
 * What a job says in place of its description when its posting could not be read. Each is one
 * fixed sentence, so that the app can recognize it: it is shown as a note rather than as the
 * job's text, and duplicate detection never treats two jobs as alike because they share one.
 */
export type UnreadableReason = 'closed' | 'blocked' | 'refused' | 'sign_in' | 'unreachable' | 'no_description';

export const UNREADABLE_NOTES: Record<UnreadableReason, string> = {
  closed: 'This posting is no longer available. The employer closed or removed it before its details could be saved.',
  blocked: 'The job site protects this posting with a human verification check, so its details could not be retrieved automatically. Open the original posting to read the full description.',
  refused: 'The job site declined automated access to this posting, so its details could not be retrieved. Open the original posting to read the full description.',
  sign_in: 'This posting is only visible after signing in to the job site, so its details could not be retrieved automatically. Open the original posting to read the full description.',
  unreachable: 'The job site could not be reached when this posting was saved. Open the original posting to read the full description.',
  no_description: 'The posting page did not include a readable job description. Open the original posting to read the full details.'
};

const NOTES = new Set(Object.values(UNREADABLE_NOTES));

export function isUnreadableNote(text: string | null | undefined): boolean {
  return !!text && NOTES.has(text.trim());
}

/** Which note fits a failed reading, from its reason and the message it gave. */
export function unreadableReason(reason: ExtractionFailureReason | string, message = ''): UnreadableReason {
  if (/sign(ing)? in|log ?in/i.test(message)) return 'sign_in';
  if (reason === 'not_found' || /closed or removed|no longer available/i.test(message)) return 'closed';
  if (/refused|declined|HTTP (40[0-9]|429)|responded with an error/i.test(message) || reason === 'http_error') return 'refused';
  if (reason === 'blocked' || /bot check|verification|captcha/i.test(message)) return 'blocked';
  if (reason === 'timeout' || reason === 'network' || /took too long|could not be found\. Check|timeout/i.test(message)) return 'unreachable';
  return 'no_description';
}

export function unreadableNote(reason: ExtractionFailureReason | string, message = ''): string {
  return UNREADABLE_NOTES[unreadableReason(reason, message)];
}
