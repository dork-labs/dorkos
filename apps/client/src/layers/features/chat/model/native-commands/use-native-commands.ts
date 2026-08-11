/**
 * Wires the native-command registry to its runtime capabilities (session rename,
 * toast feedback, /clear navigation, /context reveal) and exposes a single
 * `tryRun` interceptor for the chat send path. See `./registry` for the command
 * definitions.
 *
 * This is the single client-side recognition point for all three canonical
 * command intents (DOR-109): `clear` and `context` branch to their local
 * executors (never reach the runtime), while the runtime-fulfilled `compact`
 * intent — the one intent that DOES reach the runtime — is recognized here and
 * dispatched via `transport.runCommandIntent`, or honestly refused (toast, text
 * kept) when the active runtime cannot compact.
 *
 * @module features/chat/model/native-commands/use-native-commands
 */
import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { resolveCommandIntent } from '@dorkos/shared/command-intents';
import { useRenameSession } from '@/layers/entities/session';
import { useTransport } from '@/layers/shared/model';
import { dispatchCompactIntent } from './dispatch-compact-intent';
import { useUsageReveal } from '../use-usage-reveal';
import { parseNativeCommand } from './registry';

/**
 * Outcome of attempting to run input as a native (client-side) command.
 *
 * - `{ handled: false }` — not a registered native command; the caller falls
 *   through to the runtime (or the queue).
 * - `{ handled: true; ran }` — a native command was matched (never send it to the
 *   runtime). `ran` is `true` when the command performed its action and `false`
 *   when it was rejected before acting (e.g. a missing argument, or an
 *   unsupported compact), so the caller keeps the composer text on `false`
 *   instead of wiping it.
 */
export type NativeCommandResult =
  | { handled: false }
  | {
      handled: true;
      ran: boolean;
      /**
       * Present only for a command whose action completes ASYNCHRONOUSLY —
       * today the runtime-fulfilled `compact` intent (a trigger-only 202) and
       * `/rename` (an optimistic mutation). Resolves to whether the action was
       * actually accepted.
       *
       * Without it, `ran: true` overstates: it means "the dispatch started",
       * and a caller that treats a QUEUED command as spent on that basis loses
       * the message when the trigger is then refused — the `SESSION_LOCKED`
       * race this whole change is about (DOR-480). A caller holding an undo
       * (the queue's `restore`) must settle it on this, not on `ran` alone.
       * Absent for commands that finish synchronously, where `ran` is the whole
       * answer. Never rejects, and always settles — including when the composer
       * unmounts first, which is why it must come from the action's own promise
       * rather than from a per-call React Query callback.
       *
       * OBLIGATION for anyone adding an executor: if its action outlives
       * `tryRun` — a request, a mutation, anything awaited — it MUST set this.
       * Nothing in the type system enforces that; omitting it silently reverts
       * the queue to treating "dispatch started" as "message delivered", which
       * is the exact bug this field exists to close.
       */
      confirmed?: Promise<boolean>;
    };

/**
 * The active runtime's support for the runtime-fulfilled `compact` intent,
 * injected by the host so this hook gates without resolving the session's runtime
 * itself (which would couple it to the router).
 */
export interface CompactIntentSupport {
  /** Whether the active runtime can fulfill `compact`. */
  supported: boolean;
  /** The active runtime's display label, for the honest "not supported" toast. */
  runtimeLabel: string;
}

/** Injected host capabilities for the intent executors. */
export interface NativeCommandDeps {
  /**
   * Navigation for the `/clear` intent: open a fresh session in the same project,
   * linked back to `fromSessionId`. Injected by the host (which owns the router)
   * so this hook stays router-free. A no-op when omitted.
   */
  startFreshSession?: (fromSessionId: string | null) => void;
  /**
   * The active runtime's `compact` support + label. When omitted, `compact` and
   * its aliases are NOT recognized here and fall through unchanged (e.g. isolated
   * tests, surfaces with no runtime context).
   */
  compact?: CompactIntentSupport;
}

/**
 * Split composer content into its leading `/token` (without the slash) and the
 * trimmed remainder, if the content is slash-command-shaped. The remainder is
 * the intent's trailing instructions (e.g. `/compact focus on the API changes`)
 * — it must survive recognition, never be silently dropped.
 */
function splitSlashCommand(content: string): { token: string; rest: string } | null {
  const match = /^\/(\S+)([\s\S]*)$/.exec(content.trim());
  if (!match) return null;
  return { token: match[1], rest: match[2].trim() };
}

/**
 * Whether `content` is something the send funnel handles ITSELF rather than
 * sending to the runtime — a native command or any canonical command intent.
 *
 * Deliberately broader than {@link parseNativeCommand}, which matches only
 * client-native commands and pointedly skips the runtime-fulfilled `compact`
 * intent so the funnel can dispatch it. Any caller asking "will the funnel
 * swallow this?" must use THIS: gating on `parseNativeCommand` let `/compact`
 * and every alias of it through, and a `/compact` that reaches the queue flushes
 * without starting a turn, so the streaming→idle pump never re-arms and
 * everything behind it strands (DOR-480).
 *
 * Pure — recognition only, never execution, so a caller can ask the question
 * without `/clear` navigating away as a side effect. Slightly broad in one
 * direction: `tryRun` only intercepts `compact` when the host injected the
 * runtime's support, so with no support wired this answers `true` for something
 * that would in fact fall through. Callers use it to WARN, never to refuse.
 *
 * @param content - Composer content (trimmed or not).
 */
export function isNativeCommandContent(content: string): boolean {
  const slash = splitSlashCommand(content);
  if (!slash) return false;
  if (resolveCommandIntent(slash.token)) return true;
  return parseNativeCommand(content.trim()) !== null;
}

/**
 * Hook providing client-side command-intent dispatch for the chat send funnel.
 *
 * @param cwd - Working directory scope for the rename mutation's cache key.
 * @param sessionId - The active session id (rename / compact target).
 * @param deps - Injected host capabilities (see {@link NativeCommandDeps}).
 * @returns `{ tryRun, commandPending }` — `tryRun(content)` recognizes a
 *   canonical intent or a native command, runs it locally (or dispatches compact
 *   to the runtime), and returns a {@link NativeCommandResult} describing whether
 *   it was handled (skip the runtime send) and whether it actually ran.
 *   `commandPending` is true while any dispatched command is still settling.
 */
export function useNativeCommands(
  cwd: string | null,
  sessionId: string | null,
  deps: NativeCommandDeps = {}
) {
  const { mutateAsync: renameMutate } = useRenameSession(cwd);
  const transport = useTransport();
  const { startFreshSession, compact } = deps;

  // In-flight dispatches. The composer deliberately KEEPS its text until a
  // command confirms (so a refused `/compact` does not eat its instructions),
  // which leaves the text sitting there with both submit paths live — press
  // Enter twice and one intent becomes two triggers. Counted rather than a
  // boolean so overlapping dispatches cannot clear the latch early.
  const [pendingCount, setPendingCount] = useState(0);

  /** Hold the latch until `confirmed` settles, whichever way it settles. */
  const track = useCallback((confirmed: Promise<boolean>) => {
    setPendingCount((n) => n + 1);
    const release = () => setPendingCount((n) => Math.max(0, n - 1));
    void confirmed.then(release, release);
  }, []);

  const tryRun = useCallback(
    (content: string): NativeCommandResult => {
      // Runtime-fulfilled intent (compact): recognized here so all three canonical
      // intents share one recognition point. Only handled when the host injected
      // the runtime's support — otherwise it falls through unchanged.
      const slash = splitSlashCommand(content);
      const intent = slash ? resolveCommandIntent(slash.token) : null;
      if (slash && intent?.fulfillment === 'runtime' && compact) {
        if (!compact.supported) {
          // Honest refusal — never send an unsupported intent to the model as text.
          toast.error(`Compact isn't supported by ${compact.runtimeLabel || 'this runtime'}`);
          return { handled: true, ran: false };
        }
        if (!sessionId) {
          toast.error('No active session to compact');
          return { handled: true, ran: false };
        }
        // Trigger-only (202); the compaction rides the durable /events stream. Do
        // NOT POST a message and never render a phantom user bubble. Trailing
        // instructions (the remainder after the token) ride along so runtimes
        // that accept compaction guidance receive them verbatim. Shared with the
        // proactive compaction chip (DOR-112) so a failed dispatch always shows
        // the same toast on both surfaces.
        //
        // The promise is HANDED BACK rather than dropped: this returns before it
        // settles, so `ran: true` alone would tell a queued `/compact` it was
        // spent even when the trigger came back `SESSION_LOCKED` and no
        // compaction ever happened. `dispatchCompactIntent` swallows its own
        // errors and resolves to a boolean, so this never rejects.
        const confirmed = dispatchCompactIntent(transport, sessionId, slash.rest || undefined);
        track(confirmed);
        return { handled: true, ran: true, confirmed };
      }

      const parsed = parseNativeCommand(content);
      if (!parsed) return { handled: false };
      // Set by an executor whose action outlives `run()` — see `confirmed` on
      // NativeCommandResult for why a caller cannot trust `ran` alone there.
      let confirmed: Promise<boolean> | undefined;
      // Build the executor context here (only when a command actually runs).
      // `renameMutate` and `transport` are stable references, so `tryRun` only
      // changes when the active session or the injected deps change.
      const ran = parsed.command.run(parsed.args, {
        sessionId,
        renameSession: (title) => {
          if (!sessionId) return; // guarded by the executor; narrows the type here
          // Settle from the MUTATION's own promise, not from per-call
          // `onSuccess`/`onError`: React Query drops those when the component
          // unmounts before the mutation lands, so a queued `/rename` whose
          // composer went away was left neither restored nor confirmed —
          // permanent limbo, with the composer never cleared and never handed
          // its text back (DOR-480). `mutateAsync`'s promise is its own and always
          // settles. The rejection arm is what makes this safe to leave
          // unawaited. Confirm the toast only on success: the shared rename
          // capability already rolls the title back and toasts on failure, so
          // an optimistic success toast would double-toast a failed rename.
          confirmed = renameMutate({ sessionId, title }).then(
            () => {
              toast.success(`Renamed session to "${title}"`);
              return true;
            },
            () => false
          );
          track(confirmed);
        },
        notify: (message, kind) =>
          kind === 'error' ? toast.error(message) : toast.success(message),
        // `/clear`: delegate to the host's navigation (no-op if none injected).
        startFreshSession: (fromSessionId) => startFreshSession?.(fromSessionId),
        // `/context`: pin the usage & cost surface open. The store is external to
        // React, so the executor toggles it imperatively.
        focusUsageSurface: () => useUsageReveal.getState().reveal(),
      });
      return { handled: true, ran, ...(confirmed ? { confirmed } : {}) };
    },
    [renameMutate, transport, sessionId, startFreshSession, compact, track]
  );

  return { tryRun, commandPending: pendingCount > 0 };
}
