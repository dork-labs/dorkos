import { browserRefusalCode } from '@/layers/entities/local-browser';

/**
 * Codes the `/api/local-browser` routes answer with a sentence written for a
 * person (the server words every browser refusal itself), with the line to
 * show when one arrives with no words.
 */
const SERVER_WORDED: Record<string, string> = {
  operator_only: 'Use DorkOS on this computer to control its browser.',
  person_only: 'Only you can do this, from DorkOS.',
  owner_only: 'Only this DorkOS owner can choose its browser.',
  invalid_request: 'Check your browser choice and try again.',
  not_found: 'Those sign-ins are already gone. Refresh and try again.',
  precondition_failed: 'Page changed. Read it again before continuing.',
  history_refused: 'DorkOS doesn’t open that page here, so you stayed on this one.',
};

/** What to say for a refusal whose words were not written for a person, or never arrived. */
const FALLBACK = 'Couldn’t reach the browser. Reconnect and try again.';

/** Render known recovery guidance, keeping arbitrary process messages out of the app. */
export function browserErrorMessage(cause: unknown): string {
  if (!cause) return FALLBACK;
  const code = browserRefusalCode(cause);
  const message = (cause as { message?: string }).message?.trim() ?? '';
  // The panel can point at the window, so it says more than the server's line.
  if (code === 'signing_in') return 'Finish signing in first. The sign-in window is open.';
  if (code && Object.hasOwn(SERVER_WORDED, code)) return message || SERVER_WORDED[code];
  // Every other browser refusal is a `conflict` whose sentence is the whole message.
  if (code === 'conflict' && message) return message;
  return FALLBACK;
}
