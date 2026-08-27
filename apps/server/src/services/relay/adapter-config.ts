/**
 * Adapter configuration file I/O, validation, masking, and hot-reload.
 *
 * Extracted from adapter-manager.ts to keep file sizes manageable.
 * All functions are stateless and operate on passed-in data.
 *
 * @module services/relay/adapter-config
 */
import { readFile, chmod, stat } from 'node:fs/promises';
import { writeFileAtomic } from '@dorkos/shared/atomic-write';
import chokidar, { type FSWatcher } from 'chokidar';
import { z } from 'zod';
import type { AdapterConfig } from '@dorkos/relay';
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
 * ## Dotted keys are resolved too
 *
 * A manifest field's key is a PATH (`outbound.headers`), while the config it
 * describes is nested. Matching declarations against top-level keys only meant
 * every nested `valueShape` silently did nothing: the webhook adapter's custom
 * headers reached `WebhookOutboundConfigSchema` as the raw textarea string,
 * failed it, and the save was refused — so that field could not be set at all,
 * on create or on edit (DOR-796). Nested paths are resolved in a second pass,
 * writing through copies so the caller's object is never mutated.
 *
 * ## Ordering: this runs AFTER the password merge
 *
 * `updateConfig` merges the stored value in for any password field the form
 * sent back as the `'***'` sentinel, and only then validates. That order is
 * load-bearing now that a secret field can hold an object: the sentinel is a
 * string, and reaching this function it would be parsed as JSON and refused.
 * Do not move the merge after this.
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

  for (const [key, shape] of shapes) {
    if (!key.includes('.')) continue;
    const parts = key.split('.');
    const current = getNestedValue(normalized, parts);
    // Absent stays absent: a field nobody filled in must not be materialized
    // as an empty value the schema would then treat as a choice.
    if (current === undefined) continue;
    setNestedValueCopying(
      normalized,
      parts,
      shape === 'id-list' ? toIdList(current) : toJsonObject(key, current)
    );
  }

  return normalized;
}

/**
 * Write a nested value, copying every container on the way down.
 *
 * {@link setNestedValue} writes in place, which would reach through the shallow
 * copy {@link normalizeFormConfig} makes and mutate the caller's own config
 * object. Copying each level keeps the normalization pure.
 *
 * @param root - The object being built (owned by the caller).
 * @param parts - Dot-notation key parts.
 * @param value - The value to set at the leaf.
 */
function setNestedValueCopying(
  root: Record<string, unknown>,
  parts: string[],
  value: unknown
): void {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    current[part] =
      typeof child === 'object' && child !== null && !Array.isArray(child) ? { ...child } : {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = value;
}

/**
 * Read a JSON-object field that may arrive as text from a textarea.
 *
 * Unparseable text is refused rather than resolved to `{}`. Swallowing it meant
 * one stray keystroke in the Slack channel settings box erased every per-channel
 * rule and reported success (DOR-640 review); a refused save leaves the stored value
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
    z.ZodType | undefined;
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
 * The outcome of reading `adapters.json`.
 *
 * Two lists, because one entry failing to parse must not decide anything about
 * the others — neither what runs nor what is written back.
 */
export interface LoadedAdapterConfigs {
  /** Entries that parsed. These are the adapters that run. */
  adapters: AdapterConfig[];
  /**
   * Entries that did not parse, kept exactly as they were on disk.
   *
   * They are not started — nothing here is understood well enough to start.
   * They are carried so that {@link saveAdapterConfig} can write them back
   * untouched: a save that dropped them would turn a typo in one integration
   * into the permanent deletion of it, at the next unrelated edit.
   *
   * Preserved **verbatim**, which includes any secret they hold in cleartext.
   * The secret migration (DOR-280) reads a config's declared secret fields, and
   * an entry nobody could parse has no declared anything — guessing at which of
   * its keys is a token would be inventing structure for a shape we just failed
   * to read. So the credential stays exactly where it was, and the load says so
   * out loud rather than letting the file look protected when it is not.
   */
  unparsed: unknown[];
}

/**
 * The `id` of an entry that failed to parse, when it has a readable one.
 *
 * An unreadable entry is still usually a *mostly* readable one — a bad enum, a
 * missing key — so its id is normally right there. Reading it is what makes the
 * entry addressable: it can be named in a log, deleted through the API, and
 * recognised as the ghost of an integration the person has since re-created.
 *
 * @param entry - A raw entry from `adapters.json`.
 * @returns The id, or `undefined` when the entry does not carry a usable one.
 */
export function unparsedEntryId(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const id = (entry as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** The shell of `adapters.json`, before anything is said about each entry. */
const AdaptersFileShellSchema = z.object({ adapters: z.array(z.unknown()) });

/**
 * Read and parse the adapter config file.
 *
 * Handles a missing file (empty adapter list) and malformed content. Never
 * throws.
 *
 * **Entries are parsed one at a time.** They used to be parsed as one array, so
 * a single unreadable entry failed the whole file and returned nothing — and
 * because the caller then persisted what it held, the next "add an
 * integration" wrote that empty list to disk and erased every integration the
 * person had. Now a bad entry is skipped and reported, its neighbours load, and
 * it is handed back in {@link LoadedAdapterConfigs.unparsed} so writing the
 * file cannot delete it.
 *
 * @param configPath - Absolute path to adapters.json
 * @returns The entries that parsed, plus the raw entries that did not
 */
export async function loadAdapterConfig(configPath: string): Promise<LoadedAdapterConfigs> {
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
    const shell = AdaptersFileShellSchema.safeParse(carryForwardAdapterDefaults(sanitized));
    if (!shell.success) {
      // Not even shaped like the file: there is no per-entry reading to do, and
      // nothing to hand back, because we cannot tell where an entry begins.
      logger.error(
        `[AdapterConfig] ${configPath} is not a valid adapters file, so no integration ` +
          `could be read from it. The file has been left exactly as it is:`,
        z.flattenError(shell.error)
      );
      return { adapters: [], unparsed: [] };
    }

    const adapters: AdapterConfig[] = [];
    const unparsed: unknown[] = [];
    for (const entry of shell.data.adapters) {
      const parsed = AdapterConfigSchema.safeParse(entry);
      if (parsed.success) {
        adapters.push(parsed.data as AdapterConfig);
      } else {
        unparsed.push(entry);
        const id = unparsedEntryId(entry);
        const named = id ? ` '${id}'` : '';
        logger.error(
          `[AdapterConfig] Skipping integration${named}: its saved settings could not be read. ` +
            `It will not start, and it has been left in the file untouched so nothing is lost:`,
          z.flattenError(parsed.error)
        );
        // Said separately because it is a different fact with a different fix:
        // the entry is preserved byte for byte, so a token inside it is NOT
        // moved into the encrypted store the way a readable entry's is.
        logger.warn(
          `[AdapterConfig] The unreadable entry${named} in ${configPath} is kept exactly as ` +
            `written, so if it holds a bot token or API key that credential stays in the file ` +
            `in plain text. Fix the entry (it will then be encrypted on the next save) or ` +
            `delete the integration to clear it.`
        );
      }
    }

    warnOnOpenDmPolicy(adapters);
    return { adapters, unparsed };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // No config file = no adapters (not an error)
      return { adapters: [], unparsed: [] };
    } else {
      logger.warn('[AdapterConfig] Failed to read config:', err);
      return { adapters: [], unparsed: [] };
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
 * Entries that could not be read on load are written back **verbatim**
 * alongside the parsed ones (see {@link LoadedAdapterConfigs.unparsed}), so
 * saving one integration never deletes another that this version could not
 * understand. Verbatim means exactly that: a secret sitting in cleartext inside
 * an unreadable entry is written back in cleartext, because the DOR-280
 * migration reads a config's declared secret fields and an unparseable entry
 * declares nothing. The load says so out loud, per entry.
 *
 * An unparsed entry is dropped when a parsed entry now carries the same `id`.
 * That is the person re-creating an integration they had to abandon, and two
 * entries under one id is a file no surface can make sense of afterwards — the
 * parsed one is the one they can see and edit, so it wins.
 *
 * @param configPath - Absolute path to adapters.json
 * @param configs - The adapter configs to write
 * @param unparsed - Raw entries carried through from the last load
 */
export async function saveAdapterConfig(
  configPath: string,
  configs: AdapterConfig[],
  unparsed: readonly unknown[] = []
): Promise<void> {
  const parsedIds = new Set(configs.map((config) => config.id));
  const kept = unparsed.filter((entry) => {
    const id = unparsedEntryId(entry);
    if (id === undefined || !parsedIds.has(id)) return true;
    logger.warn(
      `[AdapterConfig] Dropping the unreadable saved entry for '${id}': an integration with ` +
        `that name has been re-created and now works. The old, unreadable copy is being ` +
        `removed so the file holds one entry per integration.`
    );
    return false;
  });

  // `writeFileAtomic` re-asserts the mode after the rename: a pre-existing
  // file's perms survive `rename`, and the tmp file's create mode is subject to
  // the process umask.
  await writeFileAtomic(configPath, JSON.stringify({ adapters: [...configs, ...kept] }, null, 2), {
    mode: ADAPTER_CONFIG_MODE,
  });
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
        // Same atomic, serialised, owner-only path as `saveAdapterConfig`: this
        // writes the very same file, so it must not race it or land group-readable.
        await writeFileAtomic(configPath, JSON.stringify(defaultConfig, null, 2), {
          mode: ADAPTER_CONFIG_MODE,
        });
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

  // Without this handler a watcher failure (e.g. EMFILE) has nowhere to go but
  // the process-wide unhandled-error path. Adapters already loaded keep running
  // on their in-memory config; only hot-reload of external edits to
  // adapters.json stops working until the process restarts. Latched per
  // distinct error code rather than a single boolean: a benign EACCES must
  // never suppress the EMFILE storm that follows it. The Set lives in this
  // per-call closure, so one watcher's latch cannot silence another's.
  const seenCodes = new Set<string>();
  watcher.on('error', (err) => {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'unknown';
    if (seenCodes.has(code)) return;
    seenCodes.add(code);
    // Logged as an explicit object, never the bare Error: the NDJSON reporter
    // spreads what it is given, and `message`/`stack` are non-enumerable on an
    // Error, so they would vanish (DOR-832).
    logger.warn(
      `[watcher-error] AdapterConfig: ${configPath} — further ${code} errors from this watcher are suppressed`,
      {
        configPath,
        code,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
        suppressingFurtherErrors: true,
      }
    );
  });
  return watcher;
}

/** What a masked secret reads as in an API response. */
export const SECRET_MASK = '***';

/**
 * Mask password-type fields in an adapter config using the manifest definition.
 *
 * Supports dot-notation keys (e.g., `inbound.secret`) by traversing nested objects.
 *
 * A field holding a MAP of secrets (the webhook adapter's `outbound.headers`)
 * is masked value by value, so the response keeps the shape the schema
 * declares — `{"Authorization": "***"}`, not the string `"***"` where an object
 * belongs. Replacing the whole object made `GET /api/relay/adapters` lie about
 * its own type. Header NAMES stay readable on purpose: they are not secret, and
 * they are what lets someone see which headers are configured without ever
 * being shown a value.
 *
 * @param config - The raw config object
 * @param manifest - The adapter manifest with field definitions
 * @returns A deep copy of config with password fields masked
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
      current[lastKey] = maskSecretValue(current[lastKey]);
    }
  }
  return masked;
}

/**
 * Mask one secret value, keeping the shape it had.
 *
 * @param value - The stored value of a secret field.
 * @returns The mask, or an object of masks for a map of secrets.
 */
function maskSecretValue(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value).map((key) => [key, SECRET_MASK]));
  }
  return SECRET_MASK;
}

/**
 * Merge incoming config with existing, preserving password fields when masked or empty.
 *
 * A secret the person did not retype comes back as the mask, and the mask is
 * not a value — it is the absence of one. That covers both shapes: the string
 * `'***'`, and (for a map of secrets) an object whose every value is `'***'`,
 * which is what a client echoing back a masked `GET` sends.
 *
 * Runs BEFORE validation in `updateConfig`, deliberately — see
 * {@link normalizeFormConfig}.
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
    if (incomingValue === '' || incomingValue === undefined || isMaskedValue(incomingValue)) {
      const existingValue = getNestedValue(existing, parts);
      if (existingValue !== undefined) {
        setNestedValue(result, parts, existingValue);
      }
    }
  }
  return result;
}

/**
 * Whether an incoming secret value is the mask rather than a real value.
 *
 * @param value - The value the caller sent for a secret field.
 */
function isMaskedValue(value: unknown): boolean {
  if (value === SECRET_MASK) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((entry) => entry === SECRET_MASK);
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
