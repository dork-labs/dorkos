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
 *    stored secrets only when a `url`-typed field changes, but a plugin may read
 *    its endpoint from a `text`, `number` or `select` field, or from a key its
 *    manifest never declares (a plugin type has no config schema, and a save is
 *    merged as `{ ...existing, ...incoming }`). So on a connection holding a
 *    stored secret, a save that changes ANY config key, declared or not, of any
 *    type, is refused outright. Only the secret fields themselves are left to
 *    rule 1, where a masked or blank value means "keep it". The gate compares
 *    what the save would actually store with what is stored now: the edit merged
 *    over the saved config the way the save merges it (shallow, so a nested map
 *    is replaced whole), with the form shapes resolved and blanks dropped. So a
 *    blank that resets a field to its default, or a smaller map that removes
 *    entries, counts as a change, while saving the whole form back unchanged (a
 *    list, a JSON map) does not. No manifest marks a field
 *    as safe display text yet, so a label counts too. A type with no manifest
 *    counts as holding a stored secret, and every key in it counts.
 *
 * An agent writer DorkOS can't identify has no turn to read marks from, so it
 * is refused the same way: the gate fails closed. A person is never refused,
 * and the boot flag preserves prior behavior while it is off.
 *
 * Not covered:
 * - a manifest that types a secret as plain `text` (or any non-`password`
 *   type): typing a value into it is not seen as typing a secret. Rule 2 still
 *   refuses changing it on a connection that holds another stored secret;
 * - a plugin that reads a secret from outside its config (its own files or
 *   environment): DorkOS never sees that secret, so no rule here can hold it.
 *
 * @module services/relay/secrets/marked-turn-secret-gate
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { normalizeFormConfig } from '../adapter-config.js';
import { secretValues, type SecretWriter } from '../adapter-secret-policy.js';

/** Whether two config values are the same, structurally: lists and maps by content. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => sameValue(item, b[i]))
    );
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameValue(a[key], b[key]));
  }
  return false;
}

/** Whether a value is a plain object (not a list, not null). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Remove the leaf at `parts` from a cloned object, if it is there. */
function dropPath(obj: Record<string, unknown>, parts: string[]): void {
  let current: unknown = obj;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(current)) return;
    current = current[part];
  }
  if (isPlainObject(current)) delete current[parts[parts.length - 1]!];
}

/**
 * Whether a save would change anything on a connection that holds a stored
 * secret, so the secret would travel with the change. Every config key counts,
 * declared or not, of any type, except the secret fields themselves (rule 1
 * judges those). It compares the config the save would store, `{ ...existing,
 * ...incoming }` with the form shapes resolved and blanks dropped (the merge in
 * `mergeWithPasswordPreservation` and the cleaning in `normalizeFormConfig`),
 * with the config stored now, cleaned the same way.
 *
 * The comparison is strict on purpose, and each strictness fails safe: a
 * reordered list, a number sent back as text ('8443' for 8443), and, for a type
 * with no manifest, a secret sent back as the mask all count as changes.
 *
 * An add or a test has nothing stored to carry. A type with no manifest counts
 * as holding a stored secret: nothing says which of its keys are secret.
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
  if (!existing) return false;
  if (manifest && !secretValues(existing, manifest).some(({ value }) => value !== '')) {
    return false;
  }
  const projected = cleaned({ ...existing, ...incoming }, manifest);
  const stored = cleaned(existing, manifest);
  return !sameValue(projected, stored);
}

/**
 * A config as the save would leave it, minus its secret fields: form shapes
 * resolved and blanks dropped (`normalizeFormConfig`), on a copy.
 */
function cleaned(
  config: Record<string, unknown>,
  manifest: AdapterManifest | undefined
): Record<string, unknown> {
  const out = structuredClone(normalizeFormConfig(config, manifest)) as Record<string, unknown>;
  for (const field of manifest?.configFields ?? []) {
    if (field.type === 'password') dropPath(out, field.key.split('.'));
  }
  return out;
}

/** Why the gate refused, as the code the route answers with. */
export type MarkedSecretRefusalCode = 'marked_turn_typed_secret' | 'marked_turn_moves_secret';

/**
 * The refusal for one attempted write, or `null` when the gate allows it.
 *
 * @param input - The independently resolved facts for this attempted write.
 * @param input.unidentified - The writer is an agent DorkOS could not identify.
 * @param input.movesSecrets - The save changes a connection that holds stored
 *   secrets ({@link movesStoredSecrets}).
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
      error: input.turnMarked
        ? "A marked turn can't change a connection with saved secrets. Ask a person."
        : "An unrecognized agent can't change a connection with saved secrets. Ask a person.",
      code: 'marked_turn_moves_secret',
    };
  }
  return null;
}
