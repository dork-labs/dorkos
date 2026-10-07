/** Exact desktop packaging declarations; file/provenance/runtime observation remains separate. */
export function assertDesktopBrowserPackaging(
  manifest: Readonly<{ dependencies?: Readonly<Record<string, string>> }>,
  config: Readonly<{
    files?: readonly string[];
    asarUnpack?: readonly string[];
    extraResources?: unknown;
    afterPack?: string;
    mac?: Readonly<{ sign?: string | boolean }>;
  }>
) {
  if (manifest.dependencies?.['playwright-core'] !== '1.63.0')
    throw new Error('Desktop must declare its exact production browser library.');
  if (!config.files?.includes('dist/**') || !config.files.includes('package.json'))
    throw new Error('Desktop browser/controller assets must be in the original package files.');
  const globs = new Set(config.asarUnpack);
  for (const path of [
    'package.json',
    'dist/server/server-entry.mjs',
    'dist/browser/**',
    'dist/drizzle/**',
    '**/node_modules/**',
  ])
    if (!globs.has(path))
      throw new Error(`Desktop browser real-file unpack declaration is missing: ${path}`);
  if (config.afterPack !== 'dist/browser/restore-library.cjs')
    throw new Error('Desktop browser library restore hook is missing.');
  if (config.mac?.sign !== 'dist/browser/sign-browser-app.cjs')
    throw new Error('Desktop browser signing owner is missing.');
  if (config.extraResources !== undefined)
    throw new Error('Desktop browser assets must use the original single-copy package tree.');
}
