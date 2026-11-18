/**
 * The one rule for whether this server may read the macOS login Keychain.
 *
 * The login Keychain belongs to the macOS user account, not to the process: a
 * throwaway `HOME`, `DORK_HOME` or `CLAUDE_CONFIG_DIR` does not seal it off. So
 * a read from a test server reaches the person's real Keychain and can raise a
 * system prompt on their screen. A server on the test runtime therefore never
 * reads it, and every caller answers "unknown" instead.
 *
 * Every direct Keychain read in the server, and every command it starts that
 * reads the Keychain itself on macOS (`gh`), asks this function first. The
 * census in `lib/keychain/__tests__/os-keychain-policy.test.ts` fails when a new direct
 * read does not.
 *
 * @module lib/keychain/os-keychain-policy
 */
import { env } from '../../env.js';

/**
 * Whether the test runtime is on, by either source: the snapshot `env.ts` took
 * at startup, or the live variable. An in-process test server (the eval
 * harness) sets the variable after `env.ts` has loaded, so the snapshot alone
 * would miss it. Either one saying "on" keeps the Keychain closed.
 */
function testRuntimeIsOn(): boolean {
  // eslint-disable-next-line no-restricted-syntax -- the live value, read beside the startup snapshot so a later-set flag still closes the Keychain
  return env.DORKOS_TEST_RUNTIME || process.env.DORKOS_TEST_RUNTIME === 'true';
}

/**
 * Whether this server may read the macOS login Keychain right now.
 *
 * False off macOS (there is no login Keychain) and always false while the test
 * runtime is on, whatever home folders the process was started with.
 */
export function mayReadOsKeychain(): boolean {
  return process.platform === 'darwin' && !testRuntimeIsOn();
}
