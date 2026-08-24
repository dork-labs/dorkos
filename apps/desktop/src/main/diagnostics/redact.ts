import { SENSITIVE_CONFIG_KEYS } from '@dorkos/shared/config-schema';

/**
 * Masking the secrets out of a user's config before it travels in a support
 * archive.
 *
 * The archive is something a person mails, pastes into an issue, or drops in a
 * chat, so this runs two passes and a value is masked if *either* matches.
 *
 * 1. **By path**, from {@link SENSITIVE_CONFIG_KEYS} — the repo's authoritative
 *    list of which config fields hold credentials, and the same list the CLI
 *    and the operator log already redact against. This is the pass that
 *    matters: a name-based rule alone missed `tunnel.auth`, which holds an
 *    ngrok basic-auth `user:password` pair and reads like an innocent boolean.
 *    Driving off the shared constant means a fifth secret added to the schema
 *    is masked here without anyone remembering this file exists.
 * 2. **By key name**, for everything the schema does not know about —
 *    `mcpServers.*.env.API_KEY`, hand-added fields, anything an older or newer
 *    schema wrote. Deliberately broad, and matching on the key rather than the
 *    value means a secret that moved one level deeper is still covered.
 *
 * The cost of a false positive is a line that says `[redacted]` when it needn't
 * have; the cost of a false negative is a live credential in someone's inbox.
 *
 * @module main/diagnostics/redact
 */

/**
 * Dotted config paths the schema declares sensitive, as a set for lookup.
 *
 * Not a copy of the list: importing it is what makes this stay correct when
 * the schema gains a credential.
 */
const SENSITIVE_PATHS = new Set<string>(SENSITIVE_CONFIG_KEYS);

/**
 * Key names whose value is replaced wholesale, wherever they appear.
 *
 * The second pass, covering what {@link SENSITIVE_CONFIG_KEYS} cannot know
 * about. Substring and case-insensitive, so `apiKey`, `ANTHROPIC_API_KEY`,
 * `accessToken`, `clientSecret` and `passphrase` all match.
 *
 * `auth` is in the list because leaving it out is the exact mistake this
 * module already made once. Its known collateral is `auth.enabled`, which is a
 * boolean and not a secret — a report that says `[redacted]` where it could
 * have said `false` is the trade this file exists to make, and no rule that
 * exempts "obviously harmless" values is worth the next `tunnel.auth`.
 */
export const SECRET_KEY_PATTERN = /token|key|secret|password|passphrase|credential|auth/i;

/** What every masked value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Walk one level of a parsed JSON value, masking as it goes.
 *
 * @param value - The node to copy.
 * @param prefix - Dotted path of `value` from the config root, `''` at the top.
 */
function redactNode(value: unknown, prefix: string): unknown {
  // An array does not extend the path: its elements sit at the same config
  // path as the array itself, so `runtimes.accounts[0].token` is tested as
  // `runtimes.accounts.token`. That errs towards masking, which is the
  // direction this whole module errs in.
  if (Array.isArray(value)) return value.map((item) => redactNode(item, prefix));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      const path = prefix === '' ? key : `${prefix}.${key}`;
      if (SENSITIVE_PATHS.has(path) || SECRET_KEY_PATTERN.test(key)) return [key, REDACTED];
      return [key, redactNode(item, path)];
    })
  );
}

/**
 * Copy a parsed config with every secret-bearing field masked.
 *
 * Structure is preserved exactly — the same keys in the same order, arrays
 * still arrays, non-secret values untouched — so the result still answers the
 * questions a diagnostic report is read for (which runtimes are configured,
 * which port is pinned, whether login is on) while carrying no credential.
 *
 * @param value - A parsed `config.json`, or any subtree of one.
 * @returns A redacted copy. The input is never mutated.
 */
export function redactSecrets(value: unknown): unknown {
  return redactNode(value, '');
}
