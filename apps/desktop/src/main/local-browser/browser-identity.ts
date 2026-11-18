/** The guest identifies its actual Chromium engine, without the app's product tokens. */
export function chromeIdentity(
  chromeVersion: string,
  platform: NodeJS.Platform,
  architecture: string,
  platformVersion: string
) {
  const major = chromeVersion.split('.')[0]!;
  if (!/^\d+$/.test(major)) throw new Error('Chrome version is unavailable');
  const uaPlatform =
    platform === 'darwin'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : platform === 'win32'
        ? 'Windows NT 10.0; Win64; x64'
        : 'X11; Linux x86_64';
  return {
    userAgent: `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    // Electron is a Chromium embedder. Claim the engine, never the Google Chrome binary.
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: major }],
      fullVersionList: [{ brand: 'Chromium', version: chromeVersion }],
      fullVersion: chromeVersion,
      platform: platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux',
      platformVersion,
      architecture: architecture.startsWith('arm') ? 'arm' : 'x86',
      bitness: architecture.includes('64') ? '64' : '32',
      model: '',
      mobile: false,
      wow64: false,
    },
  };
}

/**
 * Give every guest request the plain identity, app-wide fallback first (DOR-4650).
 *
 * The session's user agent covers pages, but Electron gives service and shared
 * workers, and anything else outside a session, the app-wide fallback, which by
 * default names `@dorkos/desktop` and `Electron`. Sites saw that one. The app's own
 * window reads nothing from its user agent, so it loses nothing.
 *
 * @param app - Holds the app-wide fallback (Electron's `app`).
 * @param guestSession - The guest partition.
 * @param identity - The identity from {@link chromeIdentity}.
 */
export function applyGuestIdentity(
  app: { userAgentFallback: string },
  guestSession: { setUserAgent(userAgent: string): void },
  identity: ReturnType<typeof chromeIdentity>
): void {
  app.userAgentFallback = identity.userAgent;
  guestSession.setUserAgent(identity.userAgent);
}
