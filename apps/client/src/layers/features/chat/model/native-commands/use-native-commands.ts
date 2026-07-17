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
import { useCallback } from 'react';
import { toast } from 'sonner';
import { resolveCommandIntent } from '@dorkos/shared/command-intents';
import { useRenameSession } from '@/layers/entities/session';
import { useTransport } from '@/layers/shared/model';
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
export type NativeCommandResult = { handled: false } | { handled: true; ran: boolean };

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

/** Extract the leading `/token` (without the slash) from composer content, if any. */
function leadingSlashToken(content: string): string | null {
  return /^\/(\S+)/.exec(content.trim())?.[1] ?? null;
}

/**
 * Hook providing client-side command-intent dispatch for the chat send funnel.
 *
 * @param cwd - Working directory scope for the rename mutation's cache key.
 * @param sessionId - The active session id (rename / compact target).
 * @param deps - Injected host capabilities (see {@link NativeCommandDeps}).
 * @returns `{ tryRun }` — `tryRun(content)` recognizes a canonical intent or a
 *   native command, runs it locally (or dispatches compact to the runtime), and
 *   returns a {@link NativeCommandResult} describing whether it was handled (skip
 *   the runtime send) and whether it actually ran.
 */
export function useNativeCommands(
  cwd: string | null,
  sessionId: string | null,
  deps: NativeCommandDeps = {}
) {
  const { mutate: renameMutate } = useRenameSession(cwd);
  const transport = useTransport();
  const { startFreshSession, compact } = deps;

  const tryRun = useCallback(
    (content: string): NativeCommandResult => {
      // Runtime-fulfilled intent (compact): recognized here so all three canonical
      // intents share one recognition point. Only handled when the host injected
      // the runtime's support — otherwise it falls through unchanged.
      const token = leadingSlashToken(content);
      const intent = token ? resolveCommandIntent(token) : null;
      if (intent?.fulfillment === 'runtime' && compact) {
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
        // NOT POST a message and never render a phantom user bubble.
        transport.runCommandIntent(sessionId, 'compact').catch((err: unknown) => {
          const locked = (err as { code?: string }).code === 'SESSION_LOCKED';
          toast.error(
            locked
              ? 'The agent is busy — try compacting again in a moment.'
              : "Couldn't compact the conversation."
          );
        });
        return { handled: true, ran: true };
      }

      const parsed = parseNativeCommand(content);
      if (!parsed) return { handled: false };
      // Build the executor context here (only when a command actually runs).
      // `renameMutate` and `transport` are stable references, so `tryRun` only
      // changes when the active session or the injected deps change.
      const ran = parsed.command.run(parsed.args, {
        sessionId,
        renameSession: (title) => {
          if (!sessionId) return; // guarded by the executor; narrows the type here
          // Confirm only on success: the shared rename capability rolls the
          // title back and shows an error toast on failure, so firing the
          // success toast optimistically would double-toast a failed rename.
          renameMutate(
            { sessionId, title },
            { onSuccess: () => toast.success(`Renamed session to "${title}"`) }
          );
        },
        notify: (message, kind) =>
          kind === 'error' ? toast.error(message) : toast.success(message),
        // `/clear`: delegate to the host's navigation (no-op if none injected).
        startFreshSession: (fromSessionId) => startFreshSession?.(fromSessionId),
        // `/context`: pin the usage & cost surface open. The store is external to
        // React, so the executor toggles it imperatively.
        focusUsageSurface: () => useUsageReveal.getState().reveal(),
      });
      return { handled: true, ran };
    },
    [renameMutate, transport, sessionId, startFreshSession, compact]
  );

  return { tryRun };
}
