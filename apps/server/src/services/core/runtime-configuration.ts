import type { RuntimeRegistry } from './runtime-registry.js';
import { logger } from '../../lib/logger.js';

/**
 * Apply the user's configured default runtime (`runtimes.default`) once all
 * production runtimes are registered. An unregistered value (disabled runtime,
 * typo) keeps the built-in default rather than failing boot. Returns whether
 * the configured value was applied so the caller can log the outcome.
 *
 * The default is shape-neutral: nothing reads `getDefault()` expecting a
 * Claude-shaped runtime. Callers use only the `AgentRuntime` interface, so
 * `codex` or `opencode` is a legitimate `runtimes.default` — the surfaces that
 * fall back to it (models, commands, subagents, MCP config) report that
 * runtime's own truth, and MCP config degrades to "no servers" rather than
 * reading Claude's `.mcp.json`. `claude-code` remains the *shipped* default;
 * that is a product choice, not a structural constraint.
 *
 * The relay is the one genuinely Claude-specific consumer, and it does not read
 * the default at all: the composition root binds it to the concrete claude-code
 * runtime (`relayAgentRuntime` in `index.ts`). {@link getDefaultType} is still
 * consulted once inside the relay — the binding subsystem prefers the default
 * when choosing which runtime to create chat-originated sessions on — but a
 * default the relay does not hold now falls back to the runtime it does hold and
 * logs the mismatch, instead of aborting binding initialization.
 *
 * @param registry - The registry with all production runtimes registered
 * @param configured - The `runtimes.default` config value
 */
export function applyConfiguredDefaultRuntime(
  registry: RuntimeRegistry,
  configured: string
): boolean {
  if (registry.has(configured)) {
    registry.setDefault(configured);
    return true;
  }
  return false;
}

/**
 * The settings this module reads, and the news that it changed — the whole of
 * `ConfigManager` this needs, named as a port so the watcher is testable without
 * a config file.
 */
export interface DefaultRuntimeConfigSource {
  /** The `runtimes.default` value as it stands right now. */
  read(): string;
  /** Subscribe to settings writes; returns an unsubscribe function. */
  onChange(listener: (change: { sections: readonly string[] }) => void): () => void;
}

/**
 * Apply `runtimes.default` now, and keep applying it when it changes.
 *
 * The default runtime is the one execution setting that is APPLIED rather than
 * read at use: the registry holds it, and everything that mints a session asks
 * the registry. Without this, changing it in Settings would agree with the person
 * and then do nothing until they restarted the server — which is the reason the
 * change-subscription primitive exists at all (spec `execution-defaults` §3.2).
 *
 * The model and effort defaults need nothing like this. They are read at the
 * moment a session is created, so a change simply governs the next session.
 *
 * @param registry - The registry with all production runtimes registered.
 * @param source - Where the value is read from and where the news comes from.
 * @returns An unsubscribe function.
 */
export function applyAndWatchConfiguredDefaultRuntime(
  registry: RuntimeRegistry,
  source: DefaultRuntimeConfigSource
): () => void {
  const apply = (): void => {
    const configured = source.read();
    if (applyConfiguredDefaultRuntime(registry, configured)) return;
    // An unregistered value keeps the built-in default rather than failing —
    // silently, when the two already agree (a fresh install naming 'claude-code'
    // before the adapter registers is not news).
    if (configured !== registry.getDefaultType()) {
      logger.warn('[Runtime] configured runtimes.default is not registered; keeping built-in', {
        configured,
        active: registry.getDefaultType(),
      });
    }
  };

  apply();
  return source.onChange((change) => {
    if (!change.sections.includes('runtimes')) return;
    const before = registry.getDefaultType();
    apply();
    const after = registry.getDefaultType();
    if (before !== after) {
      logger.info('[Runtime] default runtime changed without a restart', { before, after });
    }
  });
}

/**
 * Construct and register an optional runtime (Codex, OpenCode), tolerating a
 * synchronous construction failure. The Codex and OpenCode SDKs resolve their
 * CLI binary at `new` time and throw if it isn't found — the norm in the
 * packaged desktop app, which bundles only the claude-code SDK. Left
 * unguarded, that throw rejects `start()` and kills the whole server process
 * (the launch-blocking crash this exists to prevent). Mirrors the "keep
 * built-in default rather than fail boot" tolerance in
 * {@link applyConfiguredDefaultRuntime} and the per-runtime degradation
 * principle already established for session listing (ADR-0310): one optional
 * runtime failing to initialize must never take the others — or the server —
 * down with it.
 *
 * @param name - Human-readable runtime name for the warning log (e.g. `'CodexRuntime'`)
 * @param remedy - Plain-language hint naming what to install or disable to silence the warning
 * @param init - Synchronous callback that constructs, registers, and wires up the runtime; its return value passes through on success
 * @returns The initialized runtime, or `undefined` if construction/registration failed
 */
export function registerOptionalRuntime<T>(
  name: string,
  remedy: string,
  init: () => T
): T | undefined {
  try {
    return init();
  } catch (err) {
    logger.warn(
      `[Runtime] ${name} failed to initialize — this runtime is disabled for this session; ${remedy}`,
      {
        err,
      }
    );
    return undefined;
  }
}
