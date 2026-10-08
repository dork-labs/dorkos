import { readOriginalSignedPresenceFile } from '../fixtures/signed-desktop/presence.js';
import { open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  SignedDesktopAcceptanceSchema,
  runSignedPackagedManagedBrowser,
} from '../fixtures/signed-packaged-managed-browser';

/** Standalone opt-in executable. Ordinary tests never launch an app or read this configuration. */
export async function runSignedDesktopAcceptanceFile(
  path: string,
  presenceFile?: string
): Promise<void> {
  const file = await open(path, 'r');
  let config: unknown;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 1 || before.size > 16_384)
      throw new Error('SIGNED_DESKTOP_CONFIG_BOUND');
    const bytes = await file.readFile();
    const after = await file.stat();
    if (
      bytes.length !== before.size ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    )
      throw new Error('SIGNED_DESKTOP_CONFIG_CHANGED');
    config = JSON.parse(bytes.toString('utf8'));
  } finally {
    await file.close();
  }
  const presence =
    presenceFile === undefined ? undefined : await readOriginalSignedPresenceFile(presenceFile);
  const lifetime = new AbortController();
  const stop = () => lifetime.abort(new Error('SIGNED_DESKTOP_ORIGINAL_PARENT_CANCELLED'));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try {
    await runSignedPackagedManagedBrowser(
      SignedDesktopAcceptanceSchema.parse(config),
      lifetime.signal,
      presence
    );
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3 && (process.argv.length !== 5 || process.argv[3] !== '--presence'))
    throw new Error('SIGNED_DESKTOP_CONFIG_PATH_REQUIRED');
  runSignedDesktopAcceptanceFile(process.argv[2]!, process.argv[4]).then(
    () =>
      console.log(
        process.argv[4]
          ? 'SIGNED_DESKTOP_MANAGED_BROWSER_CORE_PASS_OS_SCOPE_UNVERIFIED'
          : 'SIGNED_DESKTOP_MANAGED_BROWSER_PASS'
      ),
    () => {
      console.error('SIGNED_DESKTOP_MANAGED_BROWSER_REFUSED');
      process.exitCode = 1;
    }
  );
}
