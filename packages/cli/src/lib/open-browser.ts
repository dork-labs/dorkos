/**
 * Open the app in the person's default browser when the CLI starts it.
 *
 * @module lib/open-browser
 */
import { exec } from 'node:child_process';
import { childEnvironment } from '@dorkos/shared/child-environment';

/**
 * Hand a local address to the platform's opener, best-effort.
 *
 * @param url - The app's local address, which the CLI built itself.
 */
export function openInBrowser(url: string): void {
  const opener =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  exec(`${opener} ${url}`, { env: childEnvironment('os-helper') });
}
