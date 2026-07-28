/**
 * Adapter configuration file I/O, validation, masking, and hot-reload.
 *
 * Extracted from adapter-manager.ts to keep file sizes manageable.
 * All functions are stateless and operate on passed-in data.
 *
 * @module services/relay/adapter-config
 */
import { readFile, writeFile, mkdir, rename, chmod, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { z } from 'zod';
import type { AdapterConfig } from '@dorkos/relay';
import { AdaptersConfigFileSchema } from '@dorkos/shared/relay-schemas';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { logger } from '../../lib/logger.js';
import { carryForwardAdapterDefaults, warnOnOpenDmPolicy } from './safe-defaults.js';
import { AdapterError } from './adapter-error.js';
import { toIdList } from '@dorkos/relay';
import {
  AdapterConfigSchema,
  SlackAdapterConfigSchema,
  TelegramAdapterConfigSchema,
  WebhookAdapterConfigSchema,
} from '@dorkos/shared/relay-schemas';

/**
 * The schema that owns each adapter type's `config` block.
 *
 * `plugin` and `claude-code` are deliberately absent: a plugin's config shape is
 * the plugin's business, so it keeps the permissive treatment.
 */
const CONFIG_SCHEMA_BY_TYPE = {
  slack: SlackAdapterConfigSchema,
  telegram: TelegramAdapterConfigSchema,
  webhook: WebhookAdapterConfigSchema,
} as const;

/** The adapter entry minus its `config`, which is validated by type below. */
const AdapterEnvelopeSchema = AdapterConfigSchema.omit({ config: true });

/**
 * Which keys persist as something other than the text a `textarea` edits.
 *
 * Read off the manifest's `valueShape` declarations rather than listed here, so
 * this side and the form's `storedValueToFormText` can never disagree about
 * which key is which shape — the drift that turns a saved allowlist into one
 * bogus id (DOR-640 review).
 *
 * @param manifest - The manifest for the adapter being persisted, when known.
 * @returns Field key to declared value shape.
 */
function valueShapesOf(manifest?: AdapterManifest): Map<string, 'id-list' | 'json-object'> {
  const shapes = new Map<string, 'id-list' | 'json-object'>();
  for (const field of manifest?.configFields ?? []) {
    if (field.valueShape) shapes.set(field.key, field.valueShape);
  }
  return shapes;
}

/**
 * Translate a setup-form payload into the shape the adapter schemas describe.
 *
 * The form seeds every untouched field with `''` and sends a `textarea` as text
 * (`initializeValues`, in the client's `wizard/adapter-config-utils.ts`), so the
 * wizard's own payload does not match the strict schemas. Rather than loosening
 * the schemas — which cost them their literal types, and which would spread form
 * concerns into the contract — the translation happens here, at the one boundary
 * that receives form data.
 *
 * Dropping an empty string is what lets `.default()` fire for it: `.default()`
 * only replaces `undefined`, so `''` used to survive as itself. That mattered
 * most for `dmPolicy`, where `''` was neither nullish enough for the adapter's
 * `?? 'allowlist'`, equal enough for the DM gate's `=== 'allowlist'`, nor equal
 * enough for the warning's `=== 'open'` — open, and silent about it.
 *
 * @param config - The raw `config` block as the caller sent it.
 * @param manifest - The adapter's manifest, read for its `valueShape` declarations.
 * @returns The same config with form shapes resolved.
 * @throws AdapterError `INVALID_CONFIG` when a `json-object` field holds unparseable text.
 */
function normalizeFormConfig(config: unknown, manifest?: AdapterManifest): unknown {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) return config;

  const shapes = valueShapesOf(manifest);
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    const shape = shapes.get(key);
    if (shape === 'id-list') {
      normalized[key] = toIdList(value);
    } else if (shape === 'json-object') {
      normalized[key] = toJsonObject(key, value);
    } else if (value !== '') {
      // An untouched form field arrives as `''`; leaving it out lets the
      // schema's own default apply instead of persisting the blank.
      normalized[key] = value;
    }
  }
  return normalized;
}

/**
 * Read a JSON-object field that may arrive as text from a textarea.
 *
 * Unparseable text is refused rather than resolved to `{}`. Swallowing it meant
 * one stray keystroke in the Channel Overrides box erased every per-channel rule
 * and reported success (DOR-640 review); a refused save leaves the stored value
 * alone and says why. Empty text still means an empty object — that is a person
 * clearing the field, not a typo.
 *
 * @param key - Field key, for the error message.
 * @param value - The raw value, text from the form or an object from disk.
 * @returns The parsed object.
 * @throws AdapterError `INVALID_CONFIG` when the text is not valid JSON.
 */
function toJsonObject(key: string, value: unknown): unknown {
  if (typeof value !== 'string') return value ?? {};
  const trimmed = value.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    throw new AdapterError(
      `Invalid ${key}: expected JSON, and the existing value was left unchanged.`,
      'INVALID_CONFIG'
    );
  }
}

/**
 * Validate an adapter entry against **its own type's** schema before it reaches
 * disk, materializing every default it declares.
 *
 * ## Why this cannot go through `AdapterConfigSchema` alone
 *
 * That schema's `config` is a union whose last arm is
 * `z.record(z.string(), z.unknown())` — a catch-all that accepts any object and
 * materializes nothing. So a config that failed the Slack arm did not fail at
 * all; it fell through and persisted verbatim, which is the pre-fix behaviour
 * with an extra step. A Slack integration would then load with no `dmPolicy`,
 * be read as "written before the field existed", and get carried back to
 * `'open'` (DOR-604 review).
 *
 * The union is also order-sensitive: a Slack config carrying a `token` key
 * matched the Telegram arm first and had its `botToken`/`appToken`/
 * `signingSecret` **stripped** on the way to disk. Selecting the schema by
 * `type` removes that branch entirely.
 *
 * So the rule is: a Slack entry is validated by the Slack schema or it is
 * refused. Nothing is silently swallowed. {@link normalizeFormConfig} runs first
 * so the setup form's own payload — blanks and textareas — reaches the schema in
 * the shape it describes, which is what makes refusal mean "genuinely broken"
 * rather than "merely form-shaped".
 *
 * @param entry - The adapter entry about to be persisted.
 * @param manifest - The adapter's manifest, read for the `valueShape` of its
 *   textarea fields. Without it a list or object field arriving as form text is
 *   left as text and the schema refuses it, rather than being silently mangled.
 * @returns The parsed entry, with every schema default materialized.
 * @throws AdapterError `INVALID_CONFIG` when the entry does not hold.
 */
export function parseAdapterConfigForPersist(
  entry: Record<string, unknown>,
  manifest?: AdapterManifest
): AdapterConfig {
  const envelope = AdapterEnvelopeSchema.safeParse(entry);
  if (!envelope.success) {
    throw new AdapterError(
      `Invalid adapter entry: ${z.prettifyError(envelope.error)}`,
      'INVALID_CONFIG'
    );
  }

  const schema = CONFIG_SCHEMA_BY_TYPE[envelope.data.type as keyof typeof CONFIG_SCHEMA_BY_TYPE] as
    | z.ZodType
    | undefined;
  if (!schema) {
    return { ...envelope.data, config: entry.config } as AdapterConfig;
  }

  const config = schema.safeParse(normalizeFormConfig(entry.config, manifest));
  if (!config.success) {
    throw new AdapterError(
      `Invalid ${envelope.data.type} configuration: ${z.prettifyError(config.error)}`,
      'INVALID_CONFIG'
    );
  }
  return { ...envelope.data, config: config.data } as AdapterConfig;
}

/** Chokidar stability threshold before triggering hot-reload (ms). */
const CONFIG_STABILITY_THRESHOLD_MS = 150;

/** Chokidar poll interval for write-finish detection (ms). */
const CONFIG_POLL_INTERVAL_MS = 50;

/**
 * Adapter `type` values that once existed on disk but have since been removed
 * from the product. Stored configs carrying one of these types are dropped
 * (never registered) with a one-line migration hint, so a single retired
 * adapter never fails the whole config parse and takes every other adapter
 * down with it.
 */
const REMOVED_ADAPTER_TYPES: Record<string, string> = {
  'telegram-chatsdk':
    "the Telegram (Chat SDK) adapter was removed — re-create the adapter with type 'telegram'",
};

/**
 * Drop adapter entries whose `type` has been removed from the product,
 * logging a migration hint for each. Returns the parsed JSON with those
 * entries filtered out of `adapters`.
 *
 * Runs before schema validation so a retired type (no longer in the
 * `AdapterType` enum) does not fail the entire file parse.
 *
 * @param raw - The parsed (untyped) adapters config JSON
 * @returns The same object with removed-type adapters stripped
 */
function stripRemovedAdapterTypes(raw: unknown): unknown {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray((raw as { adapters?: unknown }).adapters)
  ) {
    return raw;
  }
  const record = raw as { adapters: unknown[] };
  const kept = record.adapters.filter((entry) => {
    const type = (entry as { type?: unknown; id?: unknown })?.type;
    if (typeof type === 'string' && type in REMOVED_ADAPTER_TYPES) {
      const id = (entry as { id?: unknown }).id;
      const idSuffix = typeof id === 'string' ? ` '${id}'` : '';
      logger.warn(
        `[AdapterConfig] Ignoring removed adapter${idSuffix}: ${REMOVED_ADAPTER_TYPES[type]}`
      );
      return false;
    }
    return true;
  });
  return { ...record, adapters: kept };
}

/**
 * Read and parse the adapter config file.
 *
 * Handles missing file (empty adapter list) and malformed JSON (logs
 * warning and falls back to empty list). Never throws.
 *
 * @param configPath - Absolute path to adapters.json
 * @returns Parsed adapter configs, or empty array on failure
 */
export async function loadAdapterConfig(configPath: string): Promise<AdapterConfig[]> {
  try {
    const raw = await readFile(configPath, 'utf-8');
    // Bot tokens live as credential references at rest (DOR-280), but a legacy
    // file may still carry cleartext before its first migration, and the
    // references themselves are sensitive. If an instance wrote the file before
    // we enforced 0600, or it was restored from a lax backup, tighten it on read
    // (defense in depth) without waiting for the next save.
    await repairAdapterConfigPermissions(configPath);
    const sanitized = stripRemovedAdapterTypes(JSON.parse(raw));
    // Stamp legacy entries before any schema default can fire — once
    // `SlackAdapterConfigSchema` applies its own default the old value is gone.
    const parsed = AdaptersConfigFileSchema.safeParse(carryForwardAdapterDefaults(sanitized));
    if (parsed.success) {
      warnOnOpenDmPolicy(parsed.data.adapters);
      return parsed.data.adapters;
    } else {
      logger.warn(
        '[AdapterConfig] Malformed config, skipping invalid entries:',
        z.flattenError(parsed.error)
      );
      return [];
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config file = no adapters (not an error)
      return [];
    } else {
      logger.warn('[AdapterConfig] Failed to read config:', err);
      return [];
    }
  }
}

/**
 * Owner-only file mode for `adapters.json` (`rw-------`). Bot tokens are stored
 * as credential references at rest (DOR-280), but the references — and any
 * cleartext in a not-yet-migrated legacy file — are sensitive, so the file must
 * not be readable by other local users (defense in depth).
 */
const ADAPTER_CONFIG_MODE = 0o600;

/**
 * Tighten `adapters.json` to owner-only if a read finds it group/world-readable.
 *
 * Mirrors the session-secret repair in `services/core/auth/secret.ts`: repair
 * rather than reject, warn once, and never let a stat/chmod failure break the
 * load. No-op on Windows, where POSIX mode bits do not apply.
 *
 * @param configPath - Absolute path to adapters.json.
 */
async function repairAdapterConfigPermissions(configPath: string): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const mode = (await stat(configPath)).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      await chmod(configPath, ADAPTER_CONFIG_MODE);
      logger.warn(
        `[AdapterConfig] adapters.json was readable by other users (mode ${mode.toString(8)}); tightened it to owner-only (0600)`
      );
    }
  } catch (err) {
    // A stat/chmod failure must never break loading the config.
    logger.warn('[AdapterConfig] Could not verify permissions on adapters.json:', err);
  }
}

/**
 * Persist adapter configs to disk using atomic write (tmp + rename).
 *
 * Creates the parent directory if it does not exist. The file is written
 * owner-only (`0600`) as defense in depth around the adapter secret references
 * it holds. Callers persist through `persistAdapterConfigs` (adapter-secrets),
 * which materializes any cleartext secret into a reference before this write —
 * this function does not itself guard against cleartext.
 *
 * @param configPath - Absolute path to adapters.json
 * @param configs - The adapter configs to write
 */
export async function saveAdapterConfig(
  configPath: string,
  configs: AdapterConfig[]
): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  const tmpPath = `${configPath}.tmp`;
  await writeFile(tmpPath, JSON.stringify({ adapters: configs }, null, 2), {
    encoding: 'utf-8',
    mode: ADAPTER_CONFIG_MODE,
  });
  await rename(tmpPath, configPath);
  // Re-assert the mode: a pre-existing file's perms survive `rename`, and the
  // tmp file's create mode is subject to the process umask.
  await chmod(configPath, ADAPTER_CONFIG_MODE);
}

/**
 * Generate a default adapters.json with claude-code enabled when no config exists.
 *
 * Never throws -- failures are logged as warnings.
 *
 * @param configPath - Absolute path to adapters.json
 */
export async function ensureDefaultAdapterConfig(configPath: string): Promise<void> {
  try {
    await readFile(configPath, 'utf-8');
    // Config exists -- nothing to do
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      const defaultConfig = {
        adapters: [
          {
            id: 'claude-code',
            type: 'claude-code',
            builtin: true,
            enabled: true,
            config: {
              maxConcurrent: 3,
              defaultTimeoutMs: 300_000,
            },
          },
        ],
      };
      try {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, JSON.stringify(defaultConfig, null, 2), 'utf-8');
        logger.info('[AdapterConfig] Generated default adapters.json with claude-code adapter');
      } catch (writeErr) {
        logger.warn('[AdapterConfig] Failed to write default config:', writeErr);
      }
    }
  }
}

/**
 * Start watching the config file for changes to trigger hot-reload.
 *
 * Uses chokidar with awaitWriteFinish to debounce rapid writes.
 *
 * @param configPath - Absolute path to adapters.json
 * @param onChange - Callback invoked when the config file changes
 * @returns The FSWatcher instance for cleanup
 */
export function watchAdapterConfig(configPath: string, onChange: () => void): FSWatcher {
  const watcher = chokidar.watch(configPath, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: CONFIG_STABILITY_THRESHOLD_MS,
      pollInterval: CONFIG_POLL_INTERVAL_MS,
    },
  });

  watcher.on('change', onChange);
  return watcher;
}

/**
 * Mask password-type fields in an adapter config using the manifest definition.
 *
 * Supports dot-notation keys (e.g., `inbound.secret`) by traversing nested objects.
 *
 * @param config - The raw config object
 * @param manifest - The adapter manifest with field definitions
 * @returns A deep copy of config with password fields replaced by `'***'`
 */
export function maskSensitiveFields(
  config: Record<string, unknown>,
  manifest?: AdapterManifest
): Record<string, unknown> {
  if (!manifest) return config;
  const masked = structuredClone(config) as Record<string, unknown>;
  for (const field of manifest.configFields) {
    if (field.type !== 'password') continue;
    const parts = field.key.split('.');
    let current: Record<string, unknown> = masked;
    let found = true;
    for (let i = 0; i < parts.length - 1; i++) {
      if (current[parts[i]] && typeof current[parts[i]] === 'object') {
        current = current[parts[i]] as Record<string, unknown>;
      } else {
        found = false;
        break;
      }
    }
    const lastKey = parts.at(-1)!;
    if (found && lastKey in current) {
      current[lastKey] = '***';
    }
  }
  return masked;
}

/**
 * Merge incoming config with existing, preserving password fields when masked or empty.
 *
 * @param existing - The current config values
 * @param incoming - The new config values to merge
 * @param manifest - The adapter manifest with field definitions
 * @returns Merged config with password fields preserved when appropriate
 */
export function mergeWithPasswordPreservation(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
  manifest?: AdapterManifest
): Record<string, unknown> {
  const result = { ...existing, ...incoming };
  if (!manifest) return result;

  for (const field of manifest.configFields) {
    if (field.type !== 'password') continue;
    const parts = field.key.split('.');
    const incomingValue = getNestedValue(incoming, parts);
    if (incomingValue === '' || incomingValue === '***' || incomingValue === undefined) {
      const existingValue = getNestedValue(existing, parts);
      if (existingValue !== undefined) {
        setNestedValue(result, parts, existingValue);
      }
    }
  }
  return result;
}

/**
 * Traverse a nested object using dot-notation key parts.
 *
 * @internal Shared with {@link ../adapter-secrets} for password-field access.
 * @param obj - The object to read from.
 * @param parts - Dot-notation key parts (e.g. `['inbound', 'secret']`).
 */
export function getNestedValue(obj: Record<string, unknown>, parts: string[]): unknown {
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Set a value in a nested object using dot-notation key parts, creating intermediates.
 *
 * @internal Shared with {@link ../adapter-secrets} for password-field rewrites.
 * @param obj - The object to mutate.
 * @param parts - Dot-notation key parts (e.g. `['inbound', 'secret']`).
 * @param value - The value to set at the leaf.
 */
export function setNestedValue(
  obj: Record<string, unknown>,
  parts: string[],
  value: unknown
): void {
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}
