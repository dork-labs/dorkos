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
