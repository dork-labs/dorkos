import type { LocalBrowserMode } from '@dorkos/shared/local-browser';

const MESSAGES: Record<string, string> = {
  stale_page: 'Page changed. Read it again before continuing.',
  navigation_uncertain: 'Check what happened before continuing.',
  uncertain: 'Check what happened before continuing.',
  paused: 'Agent paused. Resume when ready.',
  busy: 'Browser is busy. Wait a moment.',
  browser_download: 'Couldn’t download the browser. Check your connection and try again.',
  cancelled: 'Browser setup stopped. Open it again to continue.',
  focus_unavailable: 'This tab stopped responding. Choose it again.',
};
const STORAGE_MESSAGES = [
  'Free some space, then open the browser again.',
  'Check folder permissions, then open the browser again.',
];

/** Render known recovery guidance, keeping arbitrary process messages out of the app. */
export function browserErrorMessage(cause: unknown, mode: LocalBrowserMode): string {
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
  if (error?.code === 'unsupported_version') {
    return error.message === 'Update DorkOS to use this browser version.'
      ? 'Update DorkOS to use this browser version.'
      : 'Update your browser, then connect it again.';
  }
  const known =
    error?.code && Object.hasOwn(MESSAGES, error.code) ? MESSAGES[error.code] : undefined;
  return (
    known ??
    (mode === 'existing'
      ? 'Couldn’t connect. Open your browser and allow DorkOS to use it.'
      : 'Couldn’t reach the browser. Reconnect and try again.')
  );
}
