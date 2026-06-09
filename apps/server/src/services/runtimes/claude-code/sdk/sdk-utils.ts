import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Resolve modules relative to this file — ESM has no ambient `require`. */
const requireFrom = createRequire(import.meta.url);

/** npm name of the SDK whose bundled native binary we spawn. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/** A user prompt whose input stream stays open until {@link HeldUserPrompt.close}. */
export interface HeldUserPrompt {
  /** AsyncIterable to pass as `query({ prompt })`. */
  prompt: AsyncGenerator<{
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id: string;
  }>;
  /** Close stdin so the SDK subprocess finishes the turn and exits. Idempotent. */
  close: () => void;
}

/**
 * Wrap a plain-text user message as the AsyncIterable the SDK requires, but hold
 * the streaming-input stream open after yielding it. The SDK subprocess then
 * stays alive past the `result` message — long enough to answer control requests
 * like `getContextUsage()` — and exits only once `close()` is called (which
 * completes the generator and closes stdin). Always call `close()` (e.g. in a
 * `finally`) or the subprocess will not terminate.
 *
 * @param content - User message text.
 */
export function createHeldUserPrompt(content: string): HeldUserPrompt {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* gen() {
    yield {
      type: 'user' as const,
      message: { role: 'user' as const, content },
      parent_tool_use_id: null,
      session_id: '',
    };
    await held;
  }
  return { prompt: gen(), close: () => release() };
}

/**
 * Resolve the SDK's bundled, per-platform native Claude Code binary.
 *
 * Since 0.2.113 the Agent SDK ships Claude Code as a native binary in optional
 * dependencies named `@anthropic-ai/claude-agent-sdk-<platform>-<arch>[-musl]`,
 * exposing `claude` (or `claude.exe`) at the package root. This mirrors the SDK's
 * own resolution so we can pass the exact binary it would self-resolve — and,
 * more importantly, detect its absence (the SDK throws rather than falling back
 * to PATH when the optional dependency is missing).
 *
 * @returns Absolute path to the bundled binary, or `null` when the optional
 *   dependency for this platform/arch isn't installed.
 */
function resolveBundledClaudeBinary(): string | null {
  const { platform, arch } = process;
  const ext = platform === 'win32' ? '.exe' : '';
  // Only one variant is ever installed on a given host; try each, take the first.
  const candidates =
    platform === 'linux'
      ? [`${SDK_PKG}-linux-${arch}`, `${SDK_PKG}-linux-${arch}-musl`]
      : platform === 'android'
        ? [`${SDK_PKG}-linux-${arch}-android`]
        : [`${SDK_PKG}-${platform}-${arch}`];

  for (const pkg of candidates) {
    try {
      const resolved = requireFrom.resolve(`${pkg}/claude${ext}`);
      if (existsSync(resolved)) return resolved;
    } catch {
      /* optional dependency not installed for this variant */
    }
  }
  return null;
}

/**
 * Find a Claude Code binary on `PATH`.
 *
 * Resilience fallback for when the SDK's bundled optional dependency failed to
 * install (e.g. `--no-optional`, a musl/glibc mismatch, or a blocked download).
 * The SDK does not perform this lookup itself.
 *
 * @returns Absolute path to a `claude` on PATH, or `null` when none is found.
 */
function findClaudeOnPath(): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(locator, ['claude'], { encoding: 'utf-8' })
      .split(/\r?\n/)[0] // `where` may return multiple matches
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }
  return null;
}

/**
 * Resolve the Claude Code executable for the SDK to spawn
 * (`options.pathToClaudeCodeExecutable`).
 *
 * Resolution order (Hybrid — keeps DorkOS working without a separate Claude Code
 * install, while staying resilient if the bundled binary failed to install):
 *
 * 1. The SDK's bundled, version-matched native binary (preferred — avoids the
 *    version skew of pointing at an unrelated global install).
 * 2. A `claude` on PATH — the SDK throws rather than falling back to PATH when
 *    its bundled binary is missing, so we supply this for resilience.
 * 3. `undefined` — the SDK self-resolves and raises a clear "install Claude Code"
 *    error; {@link checkClaudeDependency} surfaces the same via the dependency check.
 *
 * The pre-0.2.113 `cli.js` resolution is gone: the SDK no longer ships `cli.js`,
 * so resolving it always failed.
 */
export function resolveClaudeCliPath(): string | undefined {
  return resolveBundledClaudeBinary() ?? findClaudeOnPath() ?? undefined;
}
