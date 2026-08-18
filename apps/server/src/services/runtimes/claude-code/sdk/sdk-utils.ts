import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type { UUID } from 'node:crypto';
import { resolveAsarUnpacked } from '../../shared/asar-path.js';
import { claudePlatformPackages, resolveProvisionedClaudePath } from '../tooling/provision.js';

/** Resolve modules relative to this file — ESM has no ambient `require`. */
const requireFrom = createRequire(import.meta.url);

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

/** One streaming-input user message, in the shape `query({ prompt })` consumes. */
type HeldPromptMessage = {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
  /**
   * When `false`, the SDK appends this message to the transcript WITHOUT running
   * an assistant turn, and merges it into the next user message that does query
   * (`SDKUserMessage.shouldQuery`, `sdk.d.ts:4764`). This is the native path for
   * a `stage` disposition (spec `persistent-session-runtime` §2.5, task 4.2).
   * Omitted for an ordinary message, which queries as usual.
   */
  shouldQuery?: boolean;
  /** The server-minted correlation id, carried as the SDK message's own `uuid`. */
  uuid?: UUID;
};

/** One message pushed into a held stream: its text, and the id it answers to. */
interface HeldPromptInput {
  content: string;
  /** Server-minted correlation id, or `undefined` for an uncorrelated message. */
  messageId?: string;
  /**
   * `false` to stage this message — appended to the transcript with no assistant
   * turn (see {@link HeldPromptMessage.shouldQuery}). Omitted for a querying
   * message.
   */
  shouldQuery?: boolean;
}

/**
 * Wrap plain text as the streaming-input user message the SDK expects, stamped
 * with the server-minted correlation id when there is one.
 *
 * The cast is the one place the two id vocabularies meet. DorkOS mints message
 * ids as plain `string`s (`MessageOpts.messageId`) because the neutral contract
 * spans three runtimes; the SDK types `uuid` as node's template-literal `UUID`.
 * Stamping is a pass-through of an id DorkOS already owns — the SDK echoes it
 * back on the `result` as `user_message_uuid` and never parses it — so narrowing
 * here is safe, and doing it once keeps the cast out of every call site.
 */
function userMessage(input: HeldPromptInput): HeldPromptMessage {
  return {
    type: 'user',
    message: { role: 'user', content: input.content },
    parent_tool_use_id: null,
    session_id: '',
    ...(input.shouldQuery === false ? { shouldQuery: false } : {}),
    ...(input.messageId !== undefined ? { uuid: input.messageId as UUID } : {}),
  };
}

/**
 * A user prompt whose input stream stays open after its initial messages, so
 * more can be {@link HeldUserPrompt.push}ed into it while it is live.
 *
 * This is the input seam a persistent session is built on: one `query()` whose
 * prompt outlives a single turn, fed message by message as they arrive, rather
 * than one `query()` per message. Create it with {@link createHeldUserPrompt}
 * (an opening message) or {@link createIdlePrompt} (none — open the process
 * first, dispatch later), then `push()` for the life of the stream.
 *
 * **Two ways it ends, and they are not the same.** DorkOS ends it with
 * `close()`, which is polite: everything already accepted still gets delivered.
 * The CONSUMER ends it by abandoning the iteration — breaking out of its
 * `for await`, or calling `return()`/`throw()` — which is abrupt: the stream
 * stops at once and anything still queued is dropped, because there is no
 * longer anybody to hand it to. Either way the stream is finished for good;
 * `push()` reports that by returning `false`.
 */
export interface HeldUserPrompt {
  /** AsyncIterable to pass as `query({ prompt })`. */
  prompt: AsyncGenerator<HeldPromptMessage>;
  /**
   * Finish the stream: deliver whatever has already been accepted, then close
   * stdin so the SDK subprocess ends the turn and exits. Idempotent. Always
   * call it (e.g. in a `finally`) or the subprocess will not terminate.
   */
  close: () => void;
  /**
   * Send another user message into the still-open stream. The CLI queues it and
   * delivers it at its next opportunity within the live turn; messages arrive in
   * the order they were pushed.
   *
   * @param content - The message text, exactly as it will reach the model.
   * @param messageId - The server-minted correlation id, stamped as the SDK
   *   message's `uuid`. The SDK echoes it back on the `result` it answers with
   *   (`user_message_uuid`), which is the ONLY non-positional way to tell which
   *   turn window a result closes — a dequeued batch coalesces into one turn, so
   *   counting results against pushes is wrong the first time two messages are
   *   dequeued together. Omit it only for a message nothing needs to correlate.
   * @returns `false`, having sent nothing, once the stream has ended — whether
   *   DorkOS closed it or the consumer walked away. A `true` is only ever a
   *   promise that the stream was open and the message was accepted, so a
   *   consumer that abandons the iteration in that same tick can still leave an
   *   accepted message undelivered.
   */
  push: (content: string, messageId?: string) => boolean;
  /**
   * Stage a message into the still-open stream: appended to the transcript with
   * `shouldQuery: false`, so the SDK runs NO assistant turn and merges it into
   * the next user message that does query (`sdk.d.ts:4764`). The disposition's
   * native path (spec `persistent-session-runtime` §2.5, task 4.2) — no window
   * opens, no `result` answers it.
   *
   * @param content - The message text, exactly as it will reach the model.
   * @param messageId - The server-minted correlation id, stamped as the SDK
   *   message's `uuid`. Unlike a querying push there is no `result` to match it
   *   against — a staged message answers nothing — but the id still identifies
   *   the entry on the durable stream.
   * @returns `false`, having sent nothing, once the stream has ended; `true`
   *   when the staged message was accepted onto the open stream — with the same
   *   caveat as {@link push} that acceptance is not delivery.
   */
  stage: (content: string, messageId?: string) => boolean;
}

/**
 * Yield each of `messages`, then hold the stream open for later pushes until it
 * ends. Shared core of {@link createHeldUserPrompt} (one message) and
 * {@link createIdlePrompt} (none): the SDK subprocess stays alive past the
 * `result` message — long enough to answer control requests like
 * `getContextUsage()` or `supportedCommands()` — and exits only once the stream
 * closes stdin. The empty-messages case yields nothing (an idle probe: no user
 * turn runs). See {@link HeldUserPrompt} for the two ways it ends.
 *
 * @param messages - User message texts to yield before holding the stream open.
 */
function createHeldPrompt(messages: readonly HeldPromptInput[]): HeldUserPrompt {
  // Queue-driven so `push()` can feed the stream after it is created (DOR-1087
  // corrective notes; the persistent pump's dispatches). The generator drains
  // the queue, then parks until the next push or the end of the stream.
  const queue = [...messages];
  let closed = false;
  let notify: (() => void) | undefined;
  const wakeUp = (): void => {
    notify?.();
    notify = undefined;
  };
  // With no messages the generator yields nothing before parking — an
  // intentional idle probe. (No require-yield disable is needed: the `yield` in
  // the loop below satisfies the rule statically even when `messages` is empty.)
  async function* gen(): AsyncGenerator<HeldPromptMessage> {
    while (true) {
      while (queue.length > 0) yield userMessage(queue.shift()!);
      if (closed) return;
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
    }
  }
  const generator = gen();

  // The consumer abandoning the stream has to be handled here rather than left
  // to the generator, for two reasons the SDK exercises in the ordinary course
  // of aborting a turn. A generator suspended at an `await` — which is exactly
  // what "held open" means — cannot be resumed by `return()`, so teardown would
  // wait forever on a hold promise nobody is left to resolve; waking it first
  // is what lets the return complete. And `closed` has to flip here too, or
  // `push()` would keep reporting success into a stream with no reader, which
  // once let message-sender count phantom corrections it never delivered.
  const abandon = (): void => {
    closed = true;
    queue.length = 0;
    wakeUp();
  };
  const prompt: AsyncGenerator<HeldPromptMessage> = {
    next: (...args) => generator.next(...args),
    return: async (value) => {
      abandon();
      return generator.return(value);
    },
    throw: async (error) => {
      abandon();
      return generator.throw(error);
    },
    [Symbol.asyncIterator]() {
      return prompt;
    },
    // `await using` is another way a consumer can walk away, so route it
    // through the same abandon path rather than the raw generator's.
    [Symbol.asyncDispose]: async () => {
      await prompt.return(undefined);
    },
  };

  return {
    prompt,
    close: () => {
      closed = true;
      wakeUp();
    },
    push: (content: string, messageId?: string) => {
      if (closed) return false;
      queue.push({ content, ...(messageId !== undefined ? { messageId } : {}) });
      wakeUp();
      return true;
    },
    stage: (content: string, messageId?: string) => {
      if (closed) return false;
      queue.push({
        content,
        shouldQuery: false,
        ...(messageId !== undefined ? { messageId } : {}),
      });
      wakeUp();
      return true;
    },
  };
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
 * @param messageId - The server-minted correlation id for the opening message,
 *   stamped as its SDK `uuid`. See {@link HeldUserPrompt.push} for why the id,
 *   and never the ordinal, is what a `result` is matched against.
 */
export function createHeldUserPrompt(content: string, messageId?: string): HeldUserPrompt {
  return createHeldPrompt([{ content, ...(messageId !== undefined ? { messageId } : {}) }]);
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
 * exposing `claude` (or `claude.exe`) at the package root (the names are listed
 * by {@link claudePlatformPackages}, shared with the provisioner so what one
 * installs is what the other resolves). This mirrors the SDK's own resolution so
 * we can pass the exact binary it would self-resolve — and, more importantly,
 * detect its absence (the SDK throws rather than falling back to PATH when the
 * optional dependency is missing).
 *
 * Inside the packaged desktop app `require.resolve` lands on a path INSIDE
 * `app.asar`, which Electron's patched `fs` reports as existing while nothing
 * can spawn it; {@link resolveAsarUnpacked} maps such a path onto the
 * `app.asar.unpacked` twin electron-builder really wrote to disk (DOR-1334).
 *
 * @returns Absolute path to the bundled binary, or `null` when the optional
 *   dependency for this platform/arch isn't installed.
 */
export function resolveBundledClaudeBinary(): string | null {
  const ext = process.platform === 'win32' ? '.exe' : '';
  // Only one variant is ever installed on a given host; try each, take the first.
  for (const pkg of claudePlatformPackages()) {
    try {
      const resolved = resolveAsarUnpacked(requireFrom.resolve(`${pkg}/claude${ext}`));
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
 * The rungs of the ONE Claude-binary ladder that resolve without spawning
 * anything: the {@link CLAUDE_CLI_PATH_ENV} override, the SDK's bundled binary,
 * then a provisioned install.
 *
 * Shared verbatim by the SDK spawn seam ({@link resolveClaudeCliPath}) and the
 * readiness probe (`resolveClaudeBinaryPath` in `tooling/claude-cli-auth.ts`),
 * which differ ONLY in how they look on `PATH` afterwards — bounded-sync for the
 * spawn seam, bounded-async for the probe, which must never block the event
 * loop. They used to differ in the rungs too, and that is precisely how the
 * packaged Mac app came to run sessions on a binary its own readiness ladder
 * called missing (DOR-1334 / F2): the spawn seam honored the env override, the
 * probe did not.
 *
 * @returns The first existing binary from those three rungs, or `null`.
 */
export function resolveClaudeBinaryBeforePath(): string | null {
  return (
    resolveClaudeBinaryFromEnv() ?? resolveBundledClaudeBinary() ?? resolveProvisionedClaudePath()
  );
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
 *    npm CLI, so the steps below are their unchanged resolution.
 * 1. The SDK's bundled, version-matched native binary (preferred — avoids the
 *    version skew of pointing at an unrelated global install).
 * 2. A binary the one-click install put under `<dorkHome>/runtimes/claude-code`
 *    (ADR-0317; `tooling/provision.ts`).
 * 3. A `claude` on PATH — the SDK throws rather than falling back to PATH when
 *    its bundled binary is missing, so we supply this for resilience.
 * 4. `undefined` — the SDK self-resolves and raises a clear "install Claude Code"
 *    error; `checkClaudeDependencies` reports the same through the dependency
 *    check, which walks this exact ladder.
 *
 * The pre-0.2.113 `cli.js` resolution is gone: the SDK no longer ships `cli.js`,
 * so resolving it always failed.
 */
export function resolveClaudeCliPath(): string | undefined {
  return resolveClaudeBinaryBeforePath() ?? findClaudeOnPath() ?? undefined;
}
