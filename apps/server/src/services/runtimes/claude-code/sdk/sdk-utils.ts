import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

/** Resolve modules relative to this file — ESM has no ambient `require`. */
const requireFrom = createRequire(import.meta.url);

/** npm name of the SDK whose bundled native binary we spawn. */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/**
 * Env override for an explicit Claude Code binary path.
 *
 * The packaged desktop app (Electron) sets this to the real, code-signed
 * `claude` binary it unpacks from its asar (see apps/desktop's
 * `server-process.ts`). There, `require.resolve` cannot find the SDK's
 * per-platform optional dependency: pnpm links that sibling package only
 * inside the SDK's own store `node_modules`, never at a top-level
 * `node_modules/@anthropic-ai/` the bundled server can walk to — and even
 * when electron-builder flattens it into the asar, the resolved `app.asar/…`
 * path is not spawnable (it lives inside the archive file, not on disk). The
 * main process therefore hands the server the real unpacked path directly.
 * Read directly from `process.env` (not the parse-once `env.ts` snapshot)
 * because this module is a shared seam also bundled into the CLI — the same
 * carve-out `secret.ts` uses for `BETTER_AUTH_SECRET`. Unset in dev and in
 * the npm CLI, so their resolution is unchanged.
 */
const CLAUDE_CLI_PATH_ENV = 'DORKOS_CLAUDE_CLI_PATH';

/**
 * An explicit, caller-provided Claude Code binary path from the environment.
 *
 * The path is trusted as given: we only confirm the file exists, not that it
 * is a genuine `claude` executable — this is a deliberate escape hatch for a
 * caller (the packaged desktop app) that already knows the exact binary it
 * bundled, mirroring how the SDK itself trusts its resolved binary path.
 *
 * @returns The absolute path if {@link CLAUDE_CLI_PATH_ENV} is set to a file
 *   that exists, otherwise `null`.
 */
function resolveClaudeBinaryFromEnv(): string | null {
  // eslint-disable-next-line no-restricted-syntax -- reading an env override, not a homedir path
  const override = process.env[CLAUDE_CLI_PATH_ENV];
  if (override && existsSync(override)) return override;
  return null;
}

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
 * Yield each of `messages` as a streaming-input user message, then hold the
 * stream open until {@link HeldUserPrompt.close}. Shared core of
 * {@link createHeldUserPrompt} (one message) and {@link createIdlePrompt} (none):
 * the SDK subprocess stays alive past the `result` message — long enough to
 * answer control requests like `getContextUsage()` or `supportedCommands()` —
 * and exits only once `close()` completes the generator and closes stdin. The
 * empty-messages case yields nothing (an idle probe: no user turn runs). Always
 * call `close()` (e.g. in a `finally`) or the subprocess will not terminate.
 *
 * @param messages - User message texts to yield before holding the stream open.
 */
function createHeldPrompt(messages: string[]): HeldUserPrompt {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // With no messages the generator yields nothing before awaiting `held` — an
  // intentional idle probe. (No require-yield disable is needed: the `yield` in
  // the loop below satisfies the rule statically even when `messages` is empty.)
  async function* gen(): AsyncGenerator<{
    type: 'user';
    message: { role: 'user'; content: string };
    parent_tool_use_id: null;
    session_id: string;
  }> {
    for (const content of messages) {
      yield {
        type: 'user' as const,
        message: { role: 'user' as const, content },
        parent_tool_use_id: null,
        session_id: '',
      };
    }
    await held;
  }
  return { prompt: gen(), close: () => release() };
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
  return createHeldPrompt([content]);
}

/**
 * A streaming-input prompt that yields NO user message and holds the stream open
 * until {@link HeldUserPrompt.close}. Passing this to `query({ prompt })` boots
 * the SDK subprocess (which loads plugins and reports its slash commands at
 * initialize) and keeps it alive to answer control requests like
 * `supportedCommands()` — WITHOUT ever running a turn, since no user message is
 * sent. Use it to probe a session's command set with zero token cost; always
 * call `close()` (e.g. in a `finally`) or the subprocess will not terminate.
 */
export function createIdlePrompt(): HeldUserPrompt {
  return createHeldPrompt([]);
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
export function resolveBundledClaudeBinary(): string | null {
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

/** Bound on the sync `which`/`where` locate so a stalled PATH mount can't hang. */
const CLI_LOCATE_TIMEOUT_MS = 5_000;

/**
 * Find a Claude Code binary on `PATH`.
 *
 * Resilience fallback for when the SDK's bundled optional dependency failed to
 * install (e.g. `--no-optional`, a musl/glibc mismatch, or a blocked download).
 * The SDK does not perform this lookup itself.
 *
 * This is the SYNCHRONOUS locate used by the sync callers (`resolveClaudeCliPath`
 * in the runtime constructor and `GET /api/config`); it is time-bounded so a
 * `PATH` entry on a stalled network mount cannot hang startup. The dependency
 * check uses the async `findBinaryOnPath` instead so it never blocks the event
 * loop at all.
 *
 * @returns Absolute path to a `claude` on PATH, or `null` when none is found.
 */
function findClaudeOnPath(): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(locator, ['claude'], {
      encoding: 'utf-8',
      timeout: CLI_LOCATE_TIMEOUT_MS,
    })
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
 * 0. An explicit path from {@link CLAUDE_CLI_PATH_ENV} (the packaged desktop
 *    app supplies its unpacked, signed binary this way — see that constant's
 *    doc for why `require.resolve` can't reach it there). Unset in dev and the
 *    npm CLI, so steps 1–3 are their unchanged resolution.
 * 1. The SDK's bundled, version-matched native binary (preferred — avoids the
 *    version skew of pointing at an unrelated global install).
 * 2. A `claude` on PATH — the SDK throws rather than falling back to PATH when
 *    its bundled binary is missing, so we supply this for resilience.
 * 3. `undefined` — the SDK self-resolves and raises a clear "install Claude Code"
 *    error; {@link checkClaudeDependencies} surfaces the same via the dependency check.
 *
 * The pre-0.2.113 `cli.js` resolution is gone: the SDK no longer ships `cli.js`,
 * so resolving it always failed.
 */
export function resolveClaudeCliPath(): string | undefined {
  return (
    resolveClaudeBinaryFromEnv() ?? resolveBundledClaudeBinary() ?? findClaudeOnPath() ?? undefined
  );
}
