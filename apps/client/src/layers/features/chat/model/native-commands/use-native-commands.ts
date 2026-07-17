/**
 * Wires the native-command registry to its runtime capabilities (session rename,
 * toast feedback) and exposes a single `tryRun` interceptor for the chat send
 * path. See `./registry` for the command definitions.
 *
 * @module features/chat/model/native-commands/use-native-commands
 */
import { useCallback } from 'react';
import { toast } from 'sonner';
import { useRenameSession } from '@/layers/entities/session';
import { useUsageReveal } from '../use-usage-reveal';
import { parseNativeCommand } from './registry';

/**
 * Outcome of attempting to run input as a native (client-side) command.
 *
 * - `{ handled: false }` — not a registered native command; the caller falls
 *   through to the runtime (or the queue).
 * - `{ handled: true; ran }` — a native command was matched (never send it to the
 *   runtime). `ran` is `true` when the command performed its action and `false`
 *   when it was rejected before acting (e.g. a missing argument), so the caller
 *   can keep the composer text on a rejection instead of wiping it.
 */
export type NativeCommandResult = { handled: false } | { handled: true; ran: boolean };

/**
 * Hook providing native (client-side) chat command dispatch.
 *
 * @param cwd - Working directory scope for the rename mutation's cache key.
 * @param sessionId - The active session id (the rename target).
 * @param startFreshSession - Injected navigation for the `/clear` intent: open a
 *   fresh session in the same project, linked back to `fromSessionId`. Injected
 *   by the host (which owns the router) so this hook stays router-free, matching
 *   the orchestrator's existing navigation-via-callbacks pattern. A no-op when
 *   omitted (e.g. isolated tests, dev surfaces without navigation).
 * @returns `{ tryRun }` — `tryRun(content)` runs a registered native command
 *   locally and returns a {@link NativeCommandResult} describing whether it was
 *   handled (skip the runtime) and whether it actually ran.
 */
export function useNativeCommands(
  cwd: string | null,
  sessionId: string | null,
  startFreshSession?: (fromSessionId: string | null) => void
) {
  const { mutate: renameMutate } = useRenameSession(cwd);

  const tryRun = useCallback(
    (content: string): NativeCommandResult => {
      const parsed = parseNativeCommand(content);
      if (!parsed) return { handled: false };
      // Build the executor context here (only when a command actually runs).
      // `renameMutate` is a stable reference from TanStack Query, so `tryRun`
      // only changes when the active session or the injected navigation changes.
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
    [renameMutate, sessionId, startFreshSession]
  );

  return { tryRun };
}
