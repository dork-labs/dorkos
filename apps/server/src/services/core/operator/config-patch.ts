/**
 * Shared user-config deep-merge patch — the single implementation of the
 * `PATCH /api/config` write SEMANTICS: merge, validate whole, persist per
 * section.
 *
 * It answers "is this a valid config, and what did storing it change", and
 * nothing about who may ask. That half lives one layer up in `config-write.ts`,
 * which is the only production caller: every door — the HTTP route, the
 * `config_patch` tool, `dorkos config set` — reaches this through the guarded
 * step, so the policy and the consent door cannot be skipped by picking a
 * different entry point.
 *
 * @module services/core/operator/config-patch
 */
import {
  UserConfigSchema,
  SENSITIVE_CONFIG_KEYS,
  type UserConfig,
} from '@dorkos/shared/config-schema';
import { configManager } from '../config-manager.js';
import { projectDisclosedConfig } from './config-disclosure.js';
import { OPERATOR_ONLY_CONFIG_PATHS } from './config-write-policy.js';
import {
  applyClaudeAccountChange,
  claudeAccountsChanged,
} from '../../runtimes/claude-code/account-switch.js';

/** Keys that must be filtered during deep merge to prevent prototype pollution. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * The user-config snapshot an untrusted caller is allowed to read: the curated
 * projection defined by {@link projectDisclosedConfig}.
 *
 * Use this for any surface that returns config to an untrusted or persisted
 * context — the operator `config_get` / `config_patch` MCP tool results, which
 * reach the tokenless external `/mcp` carve-out and land in the model's
 * tool-result context and the session transcript.
 *
 * It is an **allowlist**, not `getAll()` minus a denylist: only fields explicitly
 * classified `expose` in `config-disclosure.ts` are copied, so a newly added
 * config field is withheld until someone classifies it (and the drift guard fails
 * the build until they do). See that module for what is withheld and why.
 *
 * @returns A fresh object safe to serialize to an untrusted caller.
 */
export function sanitizedConfigSnapshot(): Record<string, unknown> {
  return projectDisclosedConfig(configManager.getAll() as unknown as Record<string, unknown>);
}

/**
 * Recursively merge `source` into `target`. Arrays are replaced (not merged);
 * `null` values from `source` override `target`; prototype-pollution keys are
 * dropped.
 *
 * @param target - The base object (a copy is returned; `target` is not mutated).
 * @param source - The patch to merge on top.
 * @returns A new merged object.
 */
export function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>
): Record<string, unknown> {
  const result = { ...target };

  for (const [key, sourceValue] of Object.entries(source)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const targetValue = result[key];

    if (
      sourceValue !== null &&
      typeof sourceValue === 'object' &&
      !Array.isArray(sourceValue) &&
      targetValue !== null &&
      typeof targetValue === 'object' &&
      !Array.isArray(targetValue)
    ) {
      result[key] = deepMerge(
        targetValue as Record<string, unknown>,
        sourceValue as Record<string, unknown>
      );
    } else {
      result[key] = sourceValue;
    }
  }

  return result;
}

/**
 * Extract all dot-path keys from a nested object.
 * Example: `{ server: { port: 4242 } }` -> `['server.port']`.
 *
 * @param obj - The object to flatten.
 * @param prefix - Internal accumulator for the current path; omit at call sites.
 * @returns Every leaf key as a dot-path string.
 */
export function flattenConfigKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const keys: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...flattenConfigKeys(value as Record<string, unknown>, fullKey));
    } else {
      keys.push(fullKey);
    }
  }

  return keys;
}

/**
 * How many paths one PATCH log line names before it stops and counts the rest.
 *
 * A readability bound, nothing more — it is NOT sized to hold a whole section,
 * because no such number exists: `runtimes` is 22 leaves, `ui` is 32. What keeps
 * the cap from hiding the leaf somebody came looking for is the ORDER, not the
 * size: {@link describeConfigWrite} names every operator-only path first, so the
 * settings that protect the instance can never be the ones truncated away. The
 * trailing count keeps the line honest about what it left out.
 */
const LOGGED_PATH_LIMIT = 8;

/**
 * Longest a single path segment may be before it is clipped.
 *
 * Segments under the record-shaped sections are chosen by the caller and bounded
 * by nothing in the schema, so one write could otherwise put a megabyte of key
 * into the log and roll every other line out of the rotation. Clipping happens
 * before quoting, so the quotes stay balanced.
 */
const MAX_SEGMENT_CHARS = 48;

/** A segment that can be written into the line as-is: no quoting, nothing to escape. */
const PLAIN_SEGMENT = /^[A-Za-z0-9_-]+$/;

/**
 * Characters that survive `JSON.stringify` but can still end a line, move a
 * cursor, or start an escape sequence in something reading the log: DEL, the C1
 * controls, the Unicode line and paragraph separators, and a stray BOM. JSON
 * escapes C0 (so `\n`, `\r` and ESC are already covered); these are the rest.
 */
const RESIDUAL_UNSAFE = new RegExp('[\\u007f-\\u009f\\u2028\\u2029\\ufeff]', 'g');

/** Whether a value is a plain object — the only thing this module descends into. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether two leaf values are the same write.
 *
 * Structural, via JSON, because config IS JSON on disk — two leaves that
 * serialize identically are the same stored setting. Arrays compare in order,
 * which is right: reordering the status-bar pins is a change somebody made.
 */
function sameLeaf(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Walk two configs together and collect the dot-path of every leaf that differs.
 *
 * @param before - The stored config before the write.
 * @param after - The stored config after it.
 * @param prefix - Accumulated path; omit at call sites.
 * @param out - Accumulator the caller owns.
 */
function collectChangedPaths(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix: string,
  out: string[]
): void {
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const path = prefix ? `${prefix}.${key}` : key;
    const a = before[key];
    const b = after[key];
    // Both branches: keep descending. Anything else — including a branch that
    // became a scalar — is compared where it stands and reported at that depth.
    if (isPlainObject(a) && isPlainObject(b)) {
      collectChangedPaths(a, b, path, out);
    } else if (!sameLeaf(a, b)) {
      out.push(path);
    }
  }
}

/**
 * Render one path segment so it cannot forge, truncate, or bloat the log line.
 *
 * A schema-declared segment (`runtimes`, `defaultTrustStop`) passes through
 * untouched, which is the overwhelmingly common case and keeps the line
 * readable. Anything else — and a segment under a record-shaped section is
 * whatever the caller typed — is clipped, JSON-quoted, and swept for the
 * characters JSON leaves alone.
 *
 * @param segment - One key from a dot-path.
 */
function renderSegment(segment: string): string {
  if (segment.length <= MAX_SEGMENT_CHARS && PLAIN_SEGMENT.test(segment)) return segment;
  const clipped =
    segment.length > MAX_SEGMENT_CHARS ? `${segment.slice(0, MAX_SEGMENT_CHARS)}…` : segment;
  return JSON.stringify(clipped).replace(
    RESIDUAL_UNSAFE,
    (char) => `\\u${char.codePointAt(0)!.toString(16).padStart(4, '0')}`
  );
}

/** Whether a changed path is, or sits under, an `operator-only` setting. */
function isOperatorOnlyPath(path: string): boolean {
  return OPERATOR_ONLY_CONFIG_PATHS.some(
    (guarded) => path === guarded || path.startsWith(`${guarded}.`)
  );
}

/**
 * Name the leaves a config write actually CHANGED, for one log line — **paths
 * only, never values** (DOR-1237).
 *
 * ## Why this is logged at all
 *
 * `runtimes.claudeCode.defaultTrustStop` drifted twice on the operator's own
 * install between sign-offs, and the question "what wrote it?" had no answer
 * anywhere on disk: the route's old line was `debug`, so a production install
 * never wrote it, and it named only the top-level section (`runtimes`) even when
 * it did. A durable, operator-only setting that can move with nothing in the log
 * is a setting nobody can audit.
 *
 * ## Why the write and not the request
 *
 * It diffs stored-before against stored-after rather than reading the patch, so
 * the line says what HAPPENED. A patch naming a key the schema does not declare
 * is stripped by Zod and named by nobody here; a patch that re-sends the value
 * already stored produces no line at all. An audit line that reported requests
 * would claim changes that never landed, which is worse than no line — it would
 * send the next investigation after a write that did not exist.
 *
 * ## Why paths and not values
 *
 * Config carries real secrets — `tunnel.authtoken`, `mcp.apiKey`,
 * `cloud.instanceToken` — and logs are read by people, shipped in bug reports,
 * and pasted into issues. So the value side is never touched. Arrays are leaves,
 * so an array's CONTENTS never reach the line either.
 *
 * ## Why a path still has to be escaped
 *
 * A path is not automatically safe just because it is not a value. Three
 * sections are `z.record`s — `ui.shapes.agentDefaults`, `workbench.defaultViewers`
 * and `providers` — so their leaf segments are CALLER-CHOSEN, and the first is
 * `agent-writable`, meaning the route's agent bar never applies to it. An agent
 * could therefore write a key containing a newline and a counterfeit
 * `[Config] Patched by …` line, forging the exact record this feature exists to
 * make trustworthy (reproduced against the real route during review). So every
 * segment goes through {@link renderSegment}, and the forgery arrives as one
 * quoted, escaped, clipped segment on one line.
 *
 * @param before - The stored config before {@link applyConfigPatch} ran.
 * @param after - The stored config after it.
 * @returns The changed paths — every operator-only one first, each group sorted
 *   — capped at {@link LOGGED_PATH_LIMIT} with a count of the remainder. `''`
 *   when nothing changed, which the caller reads as "no line".
 */
export function describeConfigWrite(before: unknown, after: unknown): string {
  if (!isPlainObject(before) || !isPlainObject(after)) return '';
  const changed: string[] = [];
  collectChangedPaths(before, after, '', changed);
  if (changed.length === 0) return '';

  // Operator-only first so the cap can never truncate the leaf an investigation
  // is looking for; sorted within each group so the same write always reads the
  // same way and two lines can be compared by eye.
  const ordered = [
    ...changed.filter(isOperatorOnlyPath).sort(),
    ...changed.filter((path) => !isOperatorOnlyPath(path)).sort(),
  ];
  const named = ordered
    .slice(0, LOGGED_PATH_LIMIT)
    .map((path) => path.split('.').map(renderSegment).join('.'))
    .join(', ');
  return ordered.length <= LOGGED_PATH_LIMIT
    ? named
    : `${named}, and ${ordered.length - LOGGED_PATH_LIMIT} more`;
}

/** Outcome of {@link applyConfigPatch}: a validated write or a typed rejection. */
export type ConfigPatchResult =
  | {
      /** The write landed. */
      ok: true;
      /**
       * The stored config as it was BEFORE the merge, for
       * {@link describeConfigWrite}.
       *
       * Returned rather than re-read by the caller because this function already
       * holds it: it reads the current config to merge onto, and the snapshot it
       * merged from is by definition the state the write replaced. A caller that
       * asked the store again would be paying for a second read AND trusting that
       * nothing moved in between.
       */
      before: UserConfig;
      /** The stored config after it. */
      config: UserConfig;
      /** Non-blocking notes — today, sensitive keys written in the clear. */
      warnings: string[];
    }
  | { ok: false; error: string; details?: string[] };

/**
 * Deep-merge `patch` onto the current config, validate the whole result against
 * {@link UserConfigSchema}, and — only if valid — persist each patched
 * top-level section via {@link configManager}. Returns a typed result rather
 * than throwing so both the route and the MCP tool map it to their own error
 * shape.
 *
 * Rejects a non-object patch and any merge that fails schema validation (no
 * partial writes on failure). Sensitive keys are surfaced as `warnings`, not
 * errors — persisting them is allowed, matching the route's long-standing
 * behavior.
 *
 * @param patch - The partial config to merge (must be a JSON object).
 * @returns `{ ok: true, config, warnings }` on success, else `{ ok: false, error, details? }`.
 */
export function applyConfigPatch(patch: unknown): ConfigPatchResult {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'Request body must be a JSON object' };
  }
  const patchObj = patch as Record<string, unknown>;

  const current = configManager.getAll();
  const merged = deepMerge(current as unknown as Record<string, unknown>, patchObj);
  const parseResult = UserConfigSchema.safeParse(merged);

  if (!parseResult.success) {
    return {
      ok: false,
      error: 'Validation failed',
      details: parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    };
  }

  // Collect sensitive-key warnings (non-blocking).
  const warnings: string[] = [];
  for (const key of flattenConfigKeys(patchObj)) {
    if (SENSITIVE_CONFIG_KEYS.includes(key as (typeof SENSITIVE_CONFIG_KEYS)[number])) {
      warnings.push(
        `'${key}' contains sensitive data. Consider using environment variables instead.`
      );
    }
  }

  // Apply each patched top-level key from the validated result.
  const validated = parseResult.data;
  for (const key of Object.keys(patchObj)) {
    if (key in validated) {
      const configKey = key as keyof typeof validated;
      configManager.set(configKey, validated[configKey]);
    }
  }

  // A write that moved the Claude accounts takes effect without a restart (spec
  // `claude-code-accounts` D5). This lives here, at the shared seam, rather than
  // in the PATCH route, because the `config_patch` operator tool reaches the same
  // function — wiring only the route would leave an account switched through the
  // tool needing a restart.
  //
  // Fire-and-forget after the write has landed: the setting is already persisted
  // and the caller's answer does not depend on the re-derivation, which is itself
  // best-effort and never throws.
  if (claudeAccountsChanged(current.runtimes, validated.runtimes)) {
    void applyClaudeAccountChange();
  }

  return { ok: true, before: current, config: configManager.getAll(), warnings };
}
