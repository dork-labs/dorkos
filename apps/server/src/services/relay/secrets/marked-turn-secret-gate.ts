/**
 * What a marked agent turn may not do to a connection's secrets while
 * `DORKOS_MARK_STRANGER_TURNS` is on (DOR-3858, DOR-4453 F2). DOR-3858 keeps an
 * outsider from leading an agent to deliver a key to the outsider's server.
 * There are two ways to do that, and both are refused:
 *
 * 1. **Type a secret in.** Refused on add, save and test, whatever address the
 *    connection names. A rule scoped to "a new address" was stepped around in
 *    two calls: add the connection at the outsider's URL with no secret, then
 *    save the secret at what is now the same address.
 * 2. **Move the stored secrets.** Rule 3 (`adapter-secret-policy.ts`) clears
 *    stored secrets only when a `url`-typed field changes. A plugin's manifest
 *    may type its endpoint as `text` or `textarea`, so a save that changes any
 *    `url`, `text` or `textarea` field of a connection holding a stored secret
 *    is refused outright. Labels and other plain text fields are caught too:
 *    no manifest says which text field is an address, so the gate takes all of
 *    them.
 *
 * An agent writer DorkOS can't identify has no turn to read marks from, so it
 * is refused the same way: the gate fails closed. A person is never refused,
 * and the boot flag preserves prior behavior while it is off.
 *
 * Not covered: a manifest that types a secret as plain `text`. Its value is
 * read at its word, so a typed value there is not seen as a secret.
 *
 * @module services/relay/secrets/marked-turn-secret-gate
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { getNestedValue } from '../adapter-config.js';
import { readIncoming, secretValues, type SecretWriter } from '../adapter-secret-policy.js';

/** The field types an address can hide in. */
const ADDRESS_LIKE_TYPES: ReadonlySet<string> = new Set(['url', 'text', 'textarea']);

/**
 * Whether a save would carry a connection's stored secrets to a changed
 * address-like field: the saved config holds at least one secret, and the edit
 * sends a different value for any `url`, `text` or `textarea` field.
 *
 * An add has no stored secrets to carry, and a type with no manifest is caught
 * by the typed-secret rule instead (every entered string counts there).
 *
 * @param existing - The saved config, or `undefined` for an add or a test.
 * @param incoming - The config exactly as the route received it.
 * @param manifest - The adapter type's manifest.
 */
export function movesStoredSecrets(
  existing: Record<string, unknown> | undefined,
  incoming: Record<string, unknown>,
  manifest: AdapterManifest | undefined
): boolean {
  if (!existing || !manifest) return false;
  if (!secretValues(existing, manifest).some(({ value }) => value !== '')) return false;
  const read = readIncoming(incoming, manifest);
  return manifest.configFields
    .filter((field) => ADDRESS_LIKE_TYPES.has(field.type))
    .some((field) => {
      const parts = field.key.split('.');
      const next = getNestedValue(read, parts);
      return next !== undefined && next !== getNestedValue(existing, parts);
    });
}

/** Why the gate refused, as the code the route answers with. */
export type MarkedSecretRefusalCode = 'marked_turn_typed_secret' | 'marked_turn_moves_secret';

/**
 * The refusal for one attempted write, or `null` when the gate allows it.
 *
 * @param input - The independently resolved facts for this attempted write.
 * @param input.unidentified - The writer is an agent DorkOS could not identify.
 * @param input.movesSecrets - The save would carry stored secrets to a changed
 *   address-like field ({@link movesStoredSecrets}).
 */
export function markedTurnSecretRefusal(input: {
  enabled: boolean;
  writer: SecretWriter;
  turnMarked: boolean;
  unidentified?: boolean;
  typedSecret: boolean;
  movesSecrets?: boolean;
}): { error: string; code: MarkedSecretRefusalCode } | null {
  if (
    !input.enabled ||
    input.writer === 'person' ||
    !(input.turnMarked || input.unidentified === true)
  ) {
    return null;
  }
  const why = input.turnMarked
    ? "This turn followed a message DorkOS can't vouch for"
    : "DorkOS couldn't tell which agent sent this";
  if (input.typedSecret) {
    return {
      error: `${why}, so it can't enter a secret. Ask a person to enter it.`,
      code: 'marked_turn_typed_secret',
    };
  }
  if (input.movesSecrets === true) {
    return {
      error: `${why}, so it can't change where a connection with saved secrets sends. Ask a person to change it.`,
      code: 'marked_turn_moves_secret',
    };
  }
  return null;
}
