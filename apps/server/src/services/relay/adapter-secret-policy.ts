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
 * 1. **A `file:` reference names only this adapter's own entries**
 *    (`relay-adapter-<id>-*`, the names {@link materializeAdapterSecrets}
 *    mints). Any other `file:` name is refused for every caller, at save and at
 *    resolve (`adapter-secrets.ts`).
 * 2. **`env:` and `keychain:` are a person's choice.** A power user may type one
 *    into a secret field, so a person may still save one. Anything else that
 *    writes one is refused: the same pairing of "a credential and where it
 *    goes" that `config-write-policy.ts` keeps operator-only for `config.json`.
 * 3. **A new address needs its secrets entered again.** When a `url` field
 *    changes, a secret field that came back masked or empty is not carried to
 *    the new address. A required one is refused; an optional one is cleared.
 *    This holds for every caller, a person's browser included, because a browser
 *    an agent drives is a person's browser to the server.
 *
 * @module services/relay/adapter-secret-policy
 */
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { parseCredentialReference } from '@dorkos/shared/config-schema';
import { AdapterError } from './adapter-error.js';
import { getNestedValue, mergeWithPasswordPreservation, SECRET_MASK } from './adapter-config.js';

/**
 * Who wrote a config: `person` only for a caller that cleared the agent bar
 * (`clearsTheAgentBar`); `agent` for everyone else, internal callers included,
 * because failing closed is the safe default for a write nobody vouched for.
 */
export type SecretWriter = 'person' | 'agent';

/** Prefix of every credential-store entry an adapter owns. */
const SECRET_KEY_PREFIX = 'relay-adapter';

/**
 * The credential-store name prefix that belongs to one adapter.
 *
 * @param adapterId - The adapter instance id.
 * @returns `relay-adapter-<id>-`; every secret this adapter stored starts with it.
 */
export function ownSecretPrefix(adapterId: string): string {
  return `${SECRET_KEY_PREFIX}-${adapterId}-`;
}

/**
 * The credential-store name for one adapter field (`relay-adapter-<id>-<field>`).
 *
 * @param adapterId - The adapter instance id.
 * @param fieldKey - The dot-notation field key, plus `.<header>` for a map entry.
 */
export function secretKeyFor(adapterId: string, fieldKey: string): string {
  return `${ownSecretPrefix(adapterId)}${fieldKey.replace(/\./g, '-')}`;
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
 * @param raw - The stored or incoming value.
 * @param allowPersonReferences - Whether `env:` and `keychain:` are allowed:
 *   true only when a person wrote the config.
 */
export function referenceRefusal(
  adapterId: string,
  raw: string,
  allowPersonReferences: boolean
): string | undefined {
  const parsed = parseCredentialReference(raw);
  if (!parsed) return undefined;
  if (parsed.scheme === 'file') {
    return parsed.value.startsWith(ownSecretPrefix(adapterId))
      ? undefined
      : 'names a stored secret that belongs to something else';
  }
  return allowPersonReferences
    ? undefined
    : `uses an ${parsed.scheme}: reference, which only a person can set`;
}

/**
 * Refuse a config whose secret fields reference anything this adapter may not
 * use. Runs on every save, before anything is written.
 *
 * @param adapterId - The adapter instance id.
 * @param config - The values being written (only these are checked, so a
 *   person's `env:` reference preserved through the mask stays valid).
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
    const refusal = referenceRefusal(adapterId, value, writer === 'person');
    if (refusal) {
      throw new AdapterError(`Field '${label}' ${refusal}.`, 'INVALID_CONFIG', adapterId);
    }
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
  assertSecretReferences(adapterId, incoming, manifest, writer);
  const moved = urlFieldKeys(manifest).some((key) => {
    const next = getNestedValue(incoming, key.split('.'));
    return next !== undefined && next !== getNestedValue(existing, key.split('.'));
  });
  if (!moved) return mergeWithPasswordPreservation(existing, incoming, manifest);

  const merged = { ...existing, ...incoming };
  const missing: string[] = [];
  for (const field of manifest?.configFields ?? []) {
    if (field.type !== 'password') continue;
    const parts = field.key.split('.');
    const fresh = freshSecret(getNestedValue(incoming, parts));
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
