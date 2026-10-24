/**
 * Which credential references an adapter config may hold, and what happens to
 * its stored secrets when its address changes (DOR-3271).
 *
 * An adapter's secret fields hold `file:`, `env:` or `keychain:` references
 * (DOR-280), resolved to real secrets when the adapter starts. Before DOR-3271
 * nothing tied a reference to the adapter that held it, and the webhook adapter
 * sends its resolved headers to whatever URL its config names. So anyone who
 * could edit an adapter config could make the server send any stored secret
 * (the Anthropic key, a Community token) or any server env var to any URL.
 *
 * Three rules close it, and this module is where they are stated:
 *
 * 1. **A `file:` reference is never accepted from a caller, and resolves only
 *    to the exact entry this adapter minted for that field.** The app only
 *    ever sends a secret or the mask; every `file:` name is minted by
 *    `materializeAdapterSecrets` as `relay-adapter-<id>-<field>`. So a `file:`
 *    value arriving through the API is refused for every caller, and at resolve
 *    a `file:` reference must equal the name minted for its own field. An exact
 *    name, not a prefix: ids may hold hyphens, so `relay-adapter-w-` is also the
 *    start of every entry adapter `w-outbound` owns.
 * 2. **`env:` and `keychain:` are a person's choice.** A power user may type one
 *    into a secret field, so a person may still save one. Anything else that
 *    writes one is refused: the same pairing of "a credential and where it
 *    goes" that `config-write-policy.ts` keeps operator-only for `config.json`.
 *    A stored connection resolves them only when the server stamped it
 *    `personWroteReferences` on a person's save ({@link stampPersonReferences});
 *    the request body cannot set that flag.
 * 3. **A new address needs its secrets entered again.** When a `url` field
 *    changes, a secret field that came back masked or empty is not carried to
 *    the new address. A required one is refused; an optional one is cleared.
 *    This holds for every caller, a person's browser included, because a browser
 *    an agent drives is a person's browser to the server. It is coarse on
 *    purpose: every secret of the adapter, not only the ones that travel to that
 *    address, because no manifest says which ones do.
 *
 * Every check reads the edit as the form shapes resolve it
 * ({@link normalizeFormConfig}), so headers sent as JSON text are checked as
 * the map they become, and a blank `url` reads as no address.
 *
 * ## What this does not cover
 *
 * `adapters.json` itself. The file watcher reloads it, and a program that can
 * write that file directly can also write `personWroteReferences` there (and
 * read the store's key under the same data folder), so it is not stopped here.
 * A `file:` name that is not the connection's own is still refused when it
 * resolves. An `env:` or `keychain:` reference saved before DOR-3271 stops
 * resolving until a person enters it again.
 *
 * @module services/relay/adapter-secret-policy
 */
import type { AdapterConfig } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { parseCredentialReference } from '@dorkos/shared/config-schema';
import { AdapterError } from './adapter-error.js';
import {
  getNestedValue,
  mergeWithPasswordPreservation,
  normalizeFormConfig,
  SECRET_MASK,
} from './adapter-config.js';

/**
 * Who wrote a config: `person` only for a caller that cleared the agent bar
 * (`clearsTheAgentBar`); `agent` for everyone else, internal callers included,
 * because failing closed is the safe default for a write nobody vouched for.
 */
export type SecretWriter = 'person' | 'agent';

/** Prefix of every credential-store entry an adapter owns. */
const SECRET_KEY_PREFIX = 'relay-adapter';

/**
 * The credential-store name for one adapter field (`relay-adapter-<id>-<field>`).
 *
 * @param adapterId - The adapter instance id.
 * @param fieldKey - The dot-notation field key, plus `.<header>` for a map entry.
 */
export function secretKeyFor(adapterId: string, fieldKey: string): string {
  return `${SECRET_KEY_PREFIX}-${adapterId}-${fieldKey.replace(/\./g, '-')}`;
}

/**
 * The dot-notation keys of an adapter type's secret (`password`) fields.
 *
 * @param manifest - The adapter manifest, or undefined for an unknown type.
 * @returns The password field keys, or an empty list.
 */
export function secretFieldKeys(manifest: AdapterManifest | undefined): string[] {
  if (!manifest) return [];
  return manifest.configFields.filter((f) => f.type === 'password').map((f) => f.key);
}

/**
 * Whether a stored secret field holds a MAP of secrets (the webhook adapter's
 * outbound headers) rather than one secret.
 *
 * @param value - The value read from a config at a secret field key.
 */
export function isSecretMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Every string value under an adapter's secret fields, one per secret, with
 * the label it is reported under (`token`, `outbound.headers.Authorization`).
 *
 * @param config - The adapter's `config` object.
 * @param manifest - The adapter type's manifest.
 */
export function secretValues(
  config: Record<string, unknown>,
  manifest: AdapterManifest | undefined
): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const key of secretFieldKeys(manifest)) {
    const value = getNestedValue(config, key.split('.'));
    if (isSecretMap(value)) {
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (typeof entryValue === 'string')
          out.push({ label: `${key}.${entryKey}`, value: entryValue });
      }
    } else if (typeof value === 'string') {
      out.push({ label: key, value });
    }
  }
  return out;
}

/**
 * Every secret value an adapter config holds, as a set: what an edit must not
 * delete from the credential store.
 *
 * @param config - The adapter's `config` object.
 * @param manifest - The adapter type's manifest.
 */
export function secretValueSet(
  config: Record<string, unknown>,
  manifest: AdapterManifest | undefined
): Set<string> {
  return new Set(secretValues(config, manifest).map((entry) => entry.value));
}

/**
 * Why one credential reference may not be used by this adapter, or `undefined`
 * when it may. A value that is not a reference (a pasted secret) is fine.
 *
 * @param adapterId - The adapter the reference sits in.
 * @param label - The field it sits in (`token`, `outbound.headers.X-Key`).
 * @param raw - The stored or incoming value.
 * @param allowPersonReferences - Whether `env:` and `keychain:` are allowed:
 *   true only when a person wrote the config.
 */
export function referenceRefusal(
  adapterId: string,
  label: string,
  raw: string,
  allowPersonReferences: boolean
): string | undefined {
  const parsed = parseCredentialReference(raw);
  if (!parsed) return undefined;
  if (parsed.scheme === 'file') {
    return parsed.value === secretKeyFor(adapterId, label)
      ? undefined
      : 'names a stored secret that belongs to something else';
  }
  return allowPersonReferences
    ? undefined
    : `uses an ${parsed.scheme}: reference, which only a person can set`;
}

/**
 * Refuse incoming secret values a caller may not write. Runs on every save,
 * before anything is written, on the values the caller sent (so a person's
 * `env:` reference preserved through the mask stays valid).
 *
 * A `file:` value is refused for everyone: only the server mints those, and a
 * caller sending one back is pointing a field at an entry by name. `env:` and
 * `keychain:` are refused unless a person is writing.
 *
 * @param adapterId - The adapter instance id.
 * @param config - The incoming values, as the form shapes resolve them.
 * @param manifest - The adapter type's manifest.
 * @param writer - Who is writing.
 * @throws AdapterError `INVALID_CONFIG` naming the first refused field.
 */
export function assertSecretReferences(
  adapterId: string,
  config: Record<string, unknown>,
  manifest: AdapterManifest | undefined,
  writer: SecretWriter
): void {
  for (const { label, value } of secretValues(config, manifest)) {
    const refusal =
      parseCredentialReference(value)?.scheme === 'file'
        ? 'names a stored secret. Enter the secret itself'
        : referenceRefusal(adapterId, label, value, writer === 'person');
    if (refusal) {
      throw new AdapterError(`Field '${label}' ${refusal}.`, 'INVALID_CONFIG', adapterId);
    }
  }
}

/**
 * The secret fields of an edit as the server will read them: masked and blank
 * secrets dropped (they ask to keep what is stored), then form shapes resolved,
 * so JSON text becomes the map it stands for.
 *
 * @param incoming - The edit as sent.
 * @param manifest - The adapter type's manifest.
 * @throws AdapterError `INVALID_CONFIG` for unparseable JSON text.
 */
export function readIncoming(
  incoming: Record<string, unknown>,
  manifest: AdapterManifest | undefined
): Record<string, unknown> {
  const view = structuredClone(incoming);
  for (const key of secretFieldKeys(manifest)) {
    const value = getNestedValue(view, key.split('.'));
    if (value === SECRET_MASK || value === '') setNested(view, key.split('.'), undefined);
  }
  return normalizeFormConfig(view, manifest) as Record<string, unknown>;
}

/** A `url` value with blank read as no address. */
function addressOf(config: Record<string, unknown>, key: string): unknown {
  const value = getNestedValue(config, key.split('.'));
  return value === '' ? undefined : value;
}

/**
 * Record, on the entry itself, whether a person wrote its `env:`/`keychain:`
 * references: the server-set flag a stored config is resolved under
 * (`AdapterConfig.personWroteReferences`).
 *
 * A person's save sets it when that save sent such a reference, or when the
 * entry already had it and still holds one. A reference merely carried through
 * the mask does not earn it, so a person saving a connection for another reason
 * never vouches for a reference somebody else wrote before DOR-3271. Anything
 * but a person keeps what was there: it cannot add such a reference
 * ({@link assertSecretReferences}).
 *
 * @param entry - The parsed entry about to be saved, updated in place; for an
 *   edit it still carries the flag as stored.
 * @param manifest - The adapter type's manifest.
 * @param writer - Who is writing.
 * @param sent - The values this save sent ({@link readIncoming} for an edit,
 *   the whole config for a new connection).
 */
export function stampPersonReferences(
  entry: AdapterConfig,
  manifest: AdapterManifest | undefined,
  writer: SecretWriter,
  sent: Record<string, unknown>
): void {
  if (writer !== 'person') return;
  const isPersonRef = (value: string) => {
    const scheme = parseCredentialReference(value)?.scheme;
    return scheme === 'env' || scheme === 'keychain';
  };
  const holds = secretValues(entry.config as Record<string, unknown>, manifest).some(({ value }) =>
    isPersonRef(value)
  );
  const wrote = secretValues(sent, manifest).some(({ value }) => isPersonRef(value));
  if (holds && (wrote || entry.personWroteReferences === true)) {
    entry.personWroteReferences = true;
  } else {
    delete entry.personWroteReferences;
  }
}

/** The `url` fields of an adapter type: where its secrets travel. */
function urlFieldKeys(manifest: AdapterManifest | undefined): string[] {
  if (!manifest) return [];
  return manifest.configFields.filter((f) => f.type === 'url').map((f) => f.key);
}

/**
 * The part of an incoming secret value that was actually entered: the value
 * itself, or for a map only its entries that are not the mask. `undefined`
 * when nothing new was entered (masked, empty or absent).
 */
function freshSecret(value: unknown): unknown {
  if (isSecretMap(value)) {
    const entered = Object.entries(value).filter(([, v]) => v !== SECRET_MASK && v !== '');
    return entered.length > 0 ? Object.fromEntries(entered) : undefined;
  }
  return value === undefined || value === '' || value === SECRET_MASK ? undefined : value;
}

/**
 * Merge an edit into an adapter's stored config, applying every secret rule.
 *
 * The incoming values are checked against {@link assertSecretReferences}. With
 * every `url` field unchanged, a masked or empty secret keeps its stored value,
 * as before. When a `url` field changes, nothing stored is carried to the new
 * address: a required secret sent back masked or empty is refused, and an
 * optional one is cleared.
 *
 * @param adapterId - The adapter instance id.
 * @param existing - The stored `config`.
 * @param incoming - The edit.
 * @param manifest - The adapter type's manifest.
 * @param writer - Who is writing.
 * @returns The merged config, ready to validate and persist.
 * @throws AdapterError `INVALID_CONFIG` when a rule refuses the edit.
 */
export function mergeSecretUpdate(
  adapterId: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  manifest: AdapterManifest | undefined,
  writer: SecretWriter
): Record<string, unknown> {
  // `mergeWithPasswordPreservation` writes stored values into nested objects it
  // shares with its input, so it gets a copy: the caller's edit must still say
  // only what was sent (`stampPersonReferences` reads it after the merge).
  incoming = structuredClone(incoming);
  const read = readIncoming(incoming, manifest);
  assertSecretReferences(adapterId, read, manifest, writer);
  const moved = urlFieldKeys(manifest).some((key) => {
    const next = addressOf(read, key);
    return next !== undefined && next !== addressOf(existing, key);
  });
  if (!moved) return mergeWithPasswordPreservation(existing, incoming, manifest);

  const merged = { ...existing, ...incoming };
  const missing: string[] = [];
  for (const field of manifest?.configFields ?? []) {
    if (field.type !== 'password') continue;
    const parts = field.key.split('.');
    const fresh = freshSecret(getNestedValue(read, parts));
    if (fresh !== undefined) {
      setNested(merged, parts, fresh);
      continue;
    }
    if (field.required) missing.push(field.label);
    setNested(merged, parts, undefined);
  }
  if (missing.length > 0) {
    throw new AdapterError(
      `A new address needs its secrets entered again: ${missing.join(', ')}.`,
      'INVALID_CONFIG',
      adapterId
    );
  }
  return merged;
}

/**
 * Set the leaf at `parts`, or remove it for `undefined`, copying each parent on
 * the way down so the stored config the merge started from is never mutated.
 */
function setNested(obj: Record<string, unknown>, parts: string[], value: unknown): void {
  let current = obj;
  for (const part of parts.slice(0, -1)) {
    const next = current[part];
    if (!isSecretMap(next)) {
      if (value === undefined) return;
      current[part] = {};
    } else {
      current[part] = { ...next };
    }
    current = current[part] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1]!;
  if (value === undefined) delete current[leaf];
  else current[leaf] = value;
}
