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
import { AdapterError } from './adapter-error.js';
import {
  approvalKeyFor,
  isPersonReference,
  isSecretMap,
  legacySecretKeyFor,
  referenceRefusal,
  secretFieldKeys,
  secretKeyFor,
  secretValues,
  type SecretWriter,
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
   * Which `env:`/`keychain:` references may resolve, by field: for a stored
   * config, the approvals a person recorded ({@link readApprovedReferences});
   * for a connection test, `'any'` when a person asked for it and none
   * otherwise (DOR-3271).
   */
  approved: ApprovedReferences | 'any';
}

/** The `env:`/`keychain:` references a person saved, by field label. */
export type ApprovedReferences = ReadonlyMap<string, string>;

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
          const moved = await moveLegacyName(config.id, `${key}.${entryKey}`, entryValue, ctx);
          if (moved) {
            value[entryKey] = moved;
            changed = true;
            continue;
          }
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
      const moved = await moveLegacyName(config.id, key, value, ctx);
      if (moved) {
        setNestedValue(cfg, parts, moved);
        changed = true;
        continue;
      }
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
 * the exact entries this adapter minted are deleted: a `file:`
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
    if (parsed?.scheme !== 'file' || parsed.value !== secretKeyFor(config.id, label)) continue;
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
  const allowed = ctx.approved === 'any' || ctx.approved.get(label) === raw;
  const refusal = referenceRefusal(adapterId, label, raw, allowed);
  if (refusal) {
    throw new Error(
      `Refused credential for adapter '${adapterId}' field '${label}': it ${refusal}`
    );
  }
}

/**
 * Move a secret stored under its pre-DOR-3271 name to {@link secretKeyFor},
 * when `raw` is exactly that old name for this adapter and field. Run on load
 * and on every save, so a connection saved before the new names keeps working.
 *
 * @returns The new `file:` reference, or `undefined` when there was nothing to move.
 */
async function moveLegacyName(
  adapterId: string,
  label: string,
  raw: string,
  ctx: MaterializeSecretsContext
): Promise<string | undefined> {
  const legacy = legacySecretKeyFor(adapterId, label);
  if (raw !== `file:${legacy}`) return undefined;
  const secret = await ctx.store.get(legacy);
  if (secret === null) return undefined;
  const ref = await ctx.store.put(secretKeyFor(adapterId, label), secret);
  await ctx.store.delete(legacy);
  logger.info(
    `[AdapterSecrets] Moved adapter '${adapterId}' field '${label}' to its new stored name.`
  );
  return ref;
}

/**
 * Refuse a new connection when the store already holds entries under the names
 * it would use: a leftover from an earlier connection with the same id must not
 * be inherited (DOR-3271).
 *
 * @param config - The connection being added, as parsed.
 * @param ctx - The credential store and manifests.
 * @throws AdapterError `INVALID_CONFIG` when a name is taken.
 */
export async function assertNoStoredSecrets(
  config: AdapterConfig,
  ctx: MaterializeSecretsContext
): Promise<void> {
  const labels = secretValues(
    config.config as Record<string, unknown>,
    ctx.manifests.get(config.type)
  ).map(({ label }) => label);
  const names = [
    ...labels.map((label) => secretKeyFor(config.id, label)),
    approvalKeyFor(config.id),
  ];
  for (const name of names) {
    if ((await ctx.store.get(name)) !== null) {
      throw new AdapterError(
        `Saved secrets from an earlier connection named '${config.id}' still exist. Choose another name.`,
        'INVALID_CONFIG',
        config.id
      );
    }
  }
}

/**
 * The references a person approved for one connection, read from the
 * encrypted store. A missing or unreadable record approves nothing.
 *
 * @param store - The encrypted credential store.
 * @param adapterId - The connection's id.
 */
export async function readApprovedReferences(
  store: CredentialStore,
  adapterId: string
): Promise<ApprovedReferences> {
  const raw = await store.get(approvalKeyFor(adapterId));
  if (!raw) return new Map();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
    return new Map(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    );
  } catch {
    return new Map();
  }
}

/** Write a connection's approvals, or delete the record when there are none. */
async function writeApprovedReferences(
  store: CredentialStore,
  adapterId: string,
  approved: ApprovedReferences
): Promise<void> {
  if (approved.size === 0) await store.delete(approvalKeyFor(adapterId));
  else await store.put(approvalKeyFor(adapterId), JSON.stringify(Object.fromEntries(approved)));
}

/**
 * The fields of a stored connection holding an `env:`/`keychain:` reference no
 * person approved. A connection with any does not start: it waits for its owner
 * to confirm ({@link approveAllReferences}).
 *
 * @param config - The stored connection.
 * @param manifest - Its type's manifest.
 * @param approved - Its recorded approvals.
 */
export function unapprovedReferences(
  config: AdapterConfig,
  manifest: AdapterManifest | undefined,
  approved: ApprovedReferences
): string[] {
  return secretValues(config.config as Record<string, unknown>, manifest)
    .filter(({ label, value }) => isPersonReference(value) && approved.get(label) !== value)
    .map(({ label }) => label);
}

/**
 * Bring a connection's approvals up to date after a save. A person's save
 * approves the `env:`/`keychain:` references it sent. Every save keeps an
 * approval whose field still holds the same reference, and drops the rest. A
 * reference carried through the mask is never newly approved, so a person
 * saving a connection for another reason does not vouch for one somebody else
 * wrote.
 *
 * @param entry - The connection as saved.
 * @param writer - Who saved it.
 * @param sent - The values the save sent (the whole config for a new connection).
 * @param ctx - The credential store and manifests.
 */
export async function recordApprovals(
  entry: AdapterConfig,
  writer: SecretWriter,
  sent: Record<string, unknown>,
  ctx: MaterializeSecretsContext
): Promise<void> {
  const manifest = ctx.manifests.get(entry.type);
  const before = await readApprovedReferences(ctx.store, entry.id);
  const sentNow = new Map(secretValues(sent, manifest).map(({ label, value }) => [label, value]));
  const next = new Map<string, string>();
  for (const { label, value } of secretValues(entry.config as Record<string, unknown>, manifest)) {
    if (!isPersonReference(value)) continue;
    const wrote = writer === 'person' && sentNow.get(label) === value;
    if (wrote || before.get(label) === value) next.set(label, value);
  }
  await writeApprovedReferences(ctx.store, entry.id, next);
}

/**
 * Approve every `env:`/`keychain:` reference a connection holds now: its owner
 * confirming a connection that was paused for having none recorded. The route
 * that calls this admits only a caller that clears the agent bar.
 *
 * @param entry - The stored connection.
 * @param ctx - The credential store and manifests.
 */
export async function approveAllReferences(
  entry: AdapterConfig,
  ctx: MaterializeSecretsContext
): Promise<void> {
  const values = secretValues(
    entry.config as Record<string, unknown>,
    ctx.manifests.get(entry.type)
  );
  const approved = new Map(
    values.filter(({ value }) => isPersonReference(value)).map(({ label, value }) => [label, value])
  );
  await writeApprovedReferences(ctx.store, entry.id, approved);
}

/**
 * Delete a removed connection's approvals record.
 *
 * @param adapterId - The removed connection's id.
 * @param store - The encrypted credential store.
 */
export async function deleteApprovedReferences(
  adapterId: string,
  store: CredentialStore
): Promise<void> {
  await store
    .delete(approvalKeyFor(adapterId))
    .catch((err: unknown) =>
      logger.warn(`[AdapterSecrets] Could not delete approvals for adapter '${adapterId}':`, err)
    );
}

/**
 * The approvals a stored connection starts under. One holding an
 * `env:`/`keychain:` reference no person approved does not start: it is added
 * to `awaiting`, which the catalog lists as waiting for its owner to confirm it
 * (DOR-3271).
 *
 * @param config - The stored connection.
 * @param manifest - Its type's manifest.
 * @param store - The encrypted credential store.
 * @param awaiting - The ids of connections waiting for their owner, updated here.
 * @throws Error when the connection must wait for its owner.
 */
export async function approvalsToStart(
  config: AdapterConfig,
  manifest: AdapterManifest | undefined,
  store: CredentialStore,
  awaiting: Set<string>
): Promise<ApprovedReferences> {
  const approved = await readApprovedReferences(store, config.id);
  if (unapprovedReferences(config, manifest, approved).length === 0) {
    awaiting.delete(config.id);
    return approved;
  }
  awaiting.add(config.id);
  throw new Error(`Adapter '${config.id}' waits for its owner to confirm its settings.`);
}
