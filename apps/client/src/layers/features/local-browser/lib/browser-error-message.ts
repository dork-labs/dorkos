const MESSAGES: Record<string, string> = {
  stale_page: 'Page changed. Read it again before continuing.',
  navigation_uncertain: 'Check what happened before continuing.',
  uncertain: 'Check what happened before continuing.',
  paused: 'Agent paused. Resume when ready.',
  busy: 'Browser is busy. Wait a moment.',
  profile_busy: 'Close the Agent browser and finish signing in, then try again.',
  profile_not_found: 'Those sign-ins are already gone. Refresh and try again.',
  sign_ins_partial: 'Some sign-ins couldn’t be cleared. Try again.',
  browser_download: 'Couldn’t download the browser. Check your connection and try again.',
  cancelled: 'Browser setup stopped. Open it again to continue.',
  focus_unavailable: 'This tab stopped responding. Choose it again.',
  handoff_open: 'An agent is waiting on you in this browser. Answer its card first.',
};
/** Refusals the server writes for a person, so its own words show. The fallback covers an empty one. */
const SERVER_WORDED: Record<string, string> = {
  local_only: 'Use DorkOS on this computer to control its browser.',
  person_only: 'Only you can do this, from DorkOS.',
  bad_request: 'Check your browser choice and try again.',
  unsupported: 'This browser can’t open here.',
};
const STORAGE_MESSAGES = [
  'Free some space, then open the browser again.',
  'Check folder permissions, then open the browser again.',
];

/** Render known recovery guidance, keeping arbitrary process messages out of the app. */
export function browserErrorMessage(cause: unknown): string {
  const error = cause as { code?: string; message?: string } | null;
  if (
    error?.code === 'busy' &&
    error.message === 'The browser is still closing. Wait before opening it again.'
  )
    return 'The browser is still closing. Wait, then try again.';
  if (error?.code === 'busy' && error.message === 'Restart DorkOS to finish closing this browser.')
    return 'Restart DorkOS to finish closing this browser.';
  if (error?.code === 'browser_storage') {
    return (
      STORAGE_MESSAGES.find((message) => message === error.message) ??
      'Couldn’t save the browser. Check free space and folder permissions.'
    );
  }
  // The panel can point at the window, so it says more than the server's line.
  if (error?.code === 'signing_in') return 'Finish signing in first. The sign-in window is open.';
  if (error?.code && Object.hasOwn(SERVER_WORDED, error.code))
    return error.message?.trim() || SERVER_WORDED[error.code];
  const known =
    error?.code && Object.hasOwn(MESSAGES, error.code) ? MESSAGES[error.code] : undefined;
  return known ?? 'Couldn’t reach the browser. Reconnect and try again.';
}
