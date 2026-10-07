/** Config admission for the staged browser opt-in; no stored value grants readiness. */
export const BROWSER_SETTING_UNAVAILABLE =
  'Shared browser is not ready on this installation. Keep it off for now.';

/** Refuse enabling before any write. There is no genuine mode-readiness producer yet. */
export function browserSettingRefusal(
  path: string,
  value: unknown,
  currentChromeUserAgent = false
): string | null {
  if (
    path === 'browser.chromeUserAgent' ||
    (path === 'browser' &&
      value !== null &&
      typeof value === 'object' &&
      'chromeUserAgent' in value &&
      (value as { chromeUserAgent?: unknown }).chromeUserAgent !== currentChromeUserAgent)
  )
    return 'Change the Chrome user agent choice in Settings, while Shared browser is off.';
  const enabled =
    path === 'browser.enabled'
      ? value
      : path === 'browser' && value !== null && typeof value === 'object'
        ? (value as { enabled?: unknown }).enabled
        : undefined;
  return enabled === true ? BROWSER_SETTING_UNAVAILABLE : null;
}
