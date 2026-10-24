/**
 * Materialize and resolve secret-bearing adapter fields as credential
 * references (DOR-280).
 *
 * Relay adapters (Telegram, Slack, …) carry bot tokens and signing secrets in
 * their config. Historically these sat in cleartext in
 * `~/.dork/relay/adapters.json`. This module keeps those secrets out of the
 * file at rest by moving each pasted secret into the encrypted
 * {@link CredentialStore} and replacing it with a `file:<name>` reference
 * before the config is written. At adapter construction the references are
 * resolved back to the real secret **in memory only** — the resolved value is
 * never persisted and never logged.
 *
 * "Which fields are secret" is driven by the adapter manifest's `password`
 * config fields, the same definition used for API masking, so the two stay in
 * lockstep. A value that is already a well-formed credential reference
 * (`keychain:`/`env:`/`file:`) is left untouched, which also lets a power user
 * opt into an `env:` or `keychain:` reference by typing it directly.
 *
 * A secret field usually holds one secret. One holds a map of them — the
 * webhook adapter's outbound headers, where an `Authorization` value is every
 * bit as sensitive as a bot token — so each value in such a map is migrated
 * and resolved individually; see {@link isSecretMap}.
 *
 * Which references an adapter may hold is `adapter-secret-policy.ts` (DOR-3271):
 * a `file:` reference resolves only to this adapter's own entries, `env:` and
 * `keychain:` only for a config a person wrote, and removal deletes only this
 * adapter's own entries.
 *
 * @module services/relay/adapter-secrets
 */
import type { AdapterConfig } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { parseCredentialReference } from '@dorkos/shared/config-schema';
import type { CredentialProvider, CredentialStore } from '../core/credential-provider.js';
import { logger } from '../../lib/logger.js';
import { getNestedValue, setNestedValue, saveAdapterConfig } from './adapter-config.js';
import {
  isSecretMap,
  ownSecretPrefix,
  referenceRefusal,
  secretFieldKeys,
  secretKeyFor,
  secretValues,
} from './adapter-secret-policy.js';

export { secretFieldKeys };

/** Dependencies for materializing pasted secrets into `file:` references. */
export interface MaterializeSecretsContext {
  /** Encrypted, never-echo store the raw secret is written into. */
  store: CredentialStore;
  /** Manifests by adapter type — supplies each type's `password` field keys. */
  manifests: Map<string, AdapterManifest>;
}

/** Dependencies for resolving credential references back to real secrets. */
export interface ResolveSecretsContext {
  /** Read port that resolves a `keychain:`/`env:`/`file:` reference. */
  provider: CredentialProvider;
  /** Manifests by adapter type — supplies each type's `password` field keys. */
  manifests: Map<string, AdapterManifest>;
  /**
   * Whether `env:` and `keychain:` references may resolve: true for a stored
   * config (an agent can never save one), false for a config nobody vouched
   * for, such as a connection test an agent asked for (DOR-3271).
   */
  allowPersonReferences: boolean;
}

/**
 * Move any cleartext secrets in `configs` into the encrypted credential store,
 * replacing each with its `file:<name>` reference **in place**.
 *
 * A field that is empty, already a well-formed credential reference, or has no
 * manifest is left untouched. This is the single funnel that guarantees a bot
 * token is never written to `adapters.json` in cleartext — both for freshly
 * created adapters and for migrating a legacy cleartext file on load. The raw
 * secret value is never logged (only field keys are).
 *
 * @param configs - Adapter configs to rewrite in place.
 * @param ctx - The credential store and manifests.
 * @returns `true` when at least one field was migrated (caller should persist).
 */
export async function materializeAdapterSecrets(
  configs: AdapterConfig[],
  ctx: MaterializeSecretsContext
): Promise<boolean> {
  let changed = false;
  for (const config of configs) {
    const keys = secretFieldKeys(ctx.manifests.get(config.type));
    if (keys.length === 0) continue;
    const cfg = config.config as Record<string, unknown>;
    for (const key of keys) {
      const parts = key.split('.');
      const value = getNestedValue(cfg, parts);

      if (isSecretMap(value)) {
        for (const [entryKey, entryValue] of Object.entries(value)) {
          if (typeof entryValue !== 'string' || entryValue.length === 0) continue;
          if (parseCredentialReference(entryValue)) continue;
          value[entryKey] = await ctx.store.put(
            secretKeyFor(config.id, `${key}.${entryKey}`),
            entryValue
          );
          changed = true;
          logger.warn(
            `[AdapterSecrets] Migrated cleartext secret for adapter '${config.id}' field ` +
              `'${key}.${entryKey}' into the encrypted credential store; adapters.json now ` +
              `holds a reference, not the value.`
          );
        }
        continue;
      }

      if (typeof value !== 'string' || value.length === 0) continue;
      // Already a reference (including a power user's env:/keychain:) — leave it.
      if (parseCredentialReference(value)) continue;
      const ref = await ctx.store.put(secretKeyFor(config.id, key), value);
      setNestedValue(cfg, parts, ref);
      changed = true;
      logger.warn(
        `[AdapterSecrets] Migrated cleartext secret for adapter '${config.id}' field '${key}' ` +
          `into the encrypted credential store; adapters.json now holds a reference, not the token.`
      );
    }
  }
  return changed;
}

/**
 * Materialize secrets into references, then atomically write the configs to
 * disk — the single funnel that guarantees `adapters.json` never holds a
 * cleartext bot token (DOR-280). Mutates `configs` in place to the reference
 * form so in-memory state matches the file.
 *
 * @param configPath - Absolute path to adapters.json.
 * @param configs - Adapter configs to persist (rewritten in place).
 * @param ctx - The credential store and manifests.
 * @param unparsed - Entries the last load could not read, written back verbatim
 *   so persisting one integration never deletes another.
 */
export async function persistAdapterConfigs(
  configPath: string,
  configs: AdapterConfig[],
  ctx: MaterializeSecretsContext,
  unparsed: readonly unknown[] = []
): Promise<void> {
  await materializeAdapterSecrets(configs, ctx);
  await saveAdapterConfig(configPath, configs, unparsed);
}

/**
 * Return a deep copy of `config` with every secret field's credential reference
 * resolved to its real secret, for handing to an adapter constructor.
 *
 * A cleartext value (a transient test config, or a not-yet-migrated field) is
 * passed through unchanged. A reference that cannot be resolved (a dangling
 * `file:`/`keychain:` entry) throws a descriptive, secret-free error rather
 * than silently handing the adapter an unusable `file:…` string as its token.
 * The resolved secret exists only in the returned object; it is never written
 * back to disk and never logged.
 *
 * A reference this adapter may not use (another owner's `file:` entry, or an
 * `env:`/`keychain:` reference in a config nobody vouched for) throws before
 * anything is read, so a planted reference never reaches the provider.
 *
 * @param config - The stored adapter config (secret fields hold references).
 * @param ctx - The credential provider and manifests.
 * @returns A clone whose secret fields hold real secrets.
 */
export async function resolveAdapterSecrets(
  config: AdapterConfig,
  ctx: ResolveSecretsContext
): Promise<AdapterConfig> {
  const keys = secretFieldKeys(ctx.manifests.get(config.type));
  if (keys.length === 0) return config;
  const clone = structuredClone(config) as AdapterConfig;
  const cfg = clone.config as Record<string, unknown>;
  for (const key of keys) {
    const parts = key.split('.');
    const value = getNestedValue(cfg, parts);

    if (isSecretMap(value)) {
      for (const [entryKey, entryValue] of Object.entries(value)) {
        if (typeof entryValue !== 'string' || entryValue.length === 0) continue;
        if (!parseCredentialReference(entryValue)) continue;
        refuseReference(config.id, `${key}.${entryKey}`, entryValue, ctx);
        const resolution = await ctx.provider.resolve(entryValue);
        if (!resolution.ok) {
          throw new Error(
            `Failed to resolve credential for adapter '${config.id}' field ` +
              `'${key}.${entryKey}': ${resolution.message}`
          );
        }
        value[entryKey] = resolution.secret;
      }
      continue;
    }

    if (typeof value !== 'string' || value.length === 0) continue;
    if (!parseCredentialReference(value)) continue; // Cleartext (test/legacy) — pass through.
    refuseReference(config.id, key, value, ctx);
    const resolution = await ctx.provider.resolve(value);
    if (!resolution.ok) {
      throw new Error(
        `Failed to resolve credential for adapter '${config.id}' field '${key}': ${resolution.message}`
      );
    }
    setNestedValue(cfg, parts, resolution.secret);
  }
  return clone;
}

/**
 * Delete the stored secrets for an adapter that is being removed.
 *
 * Best-effort cleanup (defense in depth) so a deleted adapter leaves no orphan
 * secret behind. Never throws — a failed delete is logged and ignored. Only
 * this adapter's own `relay-adapter-<id>-*` entries are deleted: a `file:`
 * reference naming any other entry (the Anthropic key, a Community token) is
 * left alone, so removing an adapter can never erase somebody else's secret
 * (DOR-3271). `env:` and `keychain:` are user-owned and never touched.
 *
 * @param config - The adapter config being removed.
 * @param ctx - The credential store and manifests.
 * @param keep - Stored values still in use, for an edit that replaced some of
 *   the adapter's secrets rather than removing the adapter.
 */
export async function deleteAdapterSecrets(
  config: AdapterConfig,
  ctx: MaterializeSecretsContext,
  keep: ReadonlySet<string> = new Set()
): Promise<void> {
  const cfg = config.config as Record<string, unknown>;
  for (const { label, value } of secretValues(cfg, ctx.manifests.get(config.type))) {
    if (keep.has(value)) continue;
    const parsed = parseCredentialReference(value);
    if (parsed?.scheme !== 'file' || !parsed.value.startsWith(ownSecretPrefix(config.id))) continue;
    try {
      await ctx.store.delete(parsed.value);
    } catch (err) {
      logger.warn(
        `[AdapterSecrets] Could not delete stored secret for adapter '${config.id}' field '${label}':`,
        err
      );
    }
  }
}

/**
 * Throw when this adapter may not resolve `raw` (see `referenceRefusal`). The
 * message names the field, never the reference, so no stored name leaks.
 */
function refuseReference(
  adapterId: string,
  label: string,
  raw: string,
  ctx: ResolveSecretsContext
): void {
  const refusal = referenceRefusal(adapterId, raw, ctx.allowPersonReferences);
  if (refusal) {
    throw new Error(
      `Refused credential for adapter '${adapterId}' field '${label}': it ${refusal}`
    );
  }
}
