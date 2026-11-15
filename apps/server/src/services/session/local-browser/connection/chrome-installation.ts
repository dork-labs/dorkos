/** Find the same installed Chrome distribution Playwright's chrome channel uses. */
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Installed browser binary only; never a person's profile or account. */
export function installedChromePath(): string | undefined {
  if (process.platform === 'darwin') {
    const binary = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    return existsSync(binary) ? binary : undefined;
  }
  if (process.platform === 'linux') {
    const binary = '/opt/google/chrome/chrome';
    return existsSync(binary) ? binary : undefined;
  }
  if (process.platform !== 'win32') return undefined;
  // Installation roots are host facts, not DorkOS settings or credentials.
  // eslint-disable-next-line no-restricted-syntax
  const env = process.env;
  const roots = [
    env.LOCALAPPDATA,
    env.PROGRAMFILES,
    env['PROGRAMFILES(X86)'],
    env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files`,
    env.HOMEDRIVE && `${env.HOMEDRIVE}\\Program Files (x86)`,
  ];
  return roots
    .filter((root): root is string => Boolean(root))
    .map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    .find(existsSync);
}
