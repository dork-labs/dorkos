/**
 * Shared user-config deep-merge patch — the single implementation of the
 * `PATCH /api/config` write semantics, used by the HTTP route and the
 * `config_patch` MCP tool so both validate through the same Zod path and both
 * persist through the same {@link configManager} calls.
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

/** Outcome of {@link applyConfigPatch}: a validated write or a typed rejection. */
export type ConfigPatchResult =
  | { ok: true; config: UserConfig; warnings: string[] }
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

  return { ok: true, config: configManager.getAll(), warnings };
}
