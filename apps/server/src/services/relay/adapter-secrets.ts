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
 * @module services/relay/adapter-secrets
 */
import type { AdapterConfig } from '@dorkos/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { parseCredentialReference } from '@dorkos/shared/config-schema';
import type { CredentialProvider, CredentialStore } from '../core/credential-provider.js';
import { logger } from '../../lib/logger.js';
import { getNestedValue, setNestedValue, saveAdapterConfig } from './adapter-config.js';

/** Prefix for the credential-store key backing an adapter secret field. */
const SECRET_KEY_PREFIX = 'relay-adapter';

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
}

/**
 * The dot-notation keys of an adapter type's secret (`password`) fields.
 *
 * @param manifest - The adapter manifest, or undefined for an unknown type.
 * @returns The password field keys (e.g. `['token']`, `['inbound.secret']`), or
 *   an empty list when the manifest is unknown or has no secret fields.
 */
export function secretFieldKeys(manifest: AdapterManifest | undefined): string[] {
  if (!manifest) return [];
  return manifest.configFields.filter((f) => f.type === 'password').map((f) => f.key);
}

/** Build the credential-store key for one adapter field (`relay-adapter-<id>-<field>`). */
function secretKeyFor(adapterId: string, fieldKey: string): string {
  return `${SECRET_KEY_PREFIX}-${adapterId}-${fieldKey.replace(/\./g, '-')}`;
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
 */
export async function persistAdapterConfigs(
  configPath: string,
  configs: AdapterConfig[],
  ctx: MaterializeSecretsContext
): Promise<void> {
  await materializeAdapterSecrets(configs, ctx);
  await saveAdapterConfig(configPath, configs);
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
    if (typeof value !== 'string' || value.length === 0) continue;
    if (!parseCredentialReference(value)) continue; // Cleartext (test/legacy) — pass through.
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
 * secret behind. Never throws — a failed delete is logged and ignored.
 *
 * @param config - The adapter config being removed.
 * @param ctx - The credential store and manifests.
 */
export async function deleteAdapterSecrets(
  config: AdapterConfig,
  ctx: MaterializeSecretsContext
): Promise<void> {
  const keys = secretFieldKeys(ctx.manifests.get(config.type));
  const cfg = config.config as Record<string, unknown>;
  for (const key of keys) {
    const value = getNestedValue(cfg, key.split('.'));
    // Only file: references live in our store; env:/keychain: are user-owned.
    if (typeof value !== 'string') continue;
    const parsed = parseCredentialReference(value);
    if (parsed?.scheme !== 'file') continue;
    try {
      await ctx.store.delete(parsed.value);
    } catch (err) {
      logger.warn(
        `[AdapterSecrets] Could not delete stored secret for adapter '${config.id}' field '${key}':`,
        err
      );
    }
  }
}
