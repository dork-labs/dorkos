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
import { parseNativeCommand } from './registry';

/**
 * Hook providing native (client-side) chat command dispatch.
 *
 * @param cwd - Working directory scope for the rename mutation's cache key.
 * @param sessionId - The active session id (the rename target).
 * @returns `{ tryRun }` — `tryRun(content)` runs a registered native command
 *   locally and returns `true` when it handled the input (so the caller skips the
 *   runtime send), or `false` to fall through to the runtime.
 */
export function useNativeCommands(cwd: string | null, sessionId: string | null) {
  const { mutate: renameMutate } = useRenameSession(cwd);

  const tryRun = useCallback(
    (content: string): boolean => {
      const parsed = parseNativeCommand(content);
      if (!parsed) return false;
      // Build the executor context here (only when a command actually runs).
      // `renameMutate` is a stable reference from TanStack Query, so `tryRun`
      // only changes when the active session changes.
      parsed.command.run(parsed.args, {
        sessionId,
        renameSession: (title) => {
          if (!sessionId) return; // guarded by the executor; narrows the type here
          renameMutate({ sessionId, title });
          toast.success(`Renamed session to "${title}"`);
        },
        notify: (message, kind) =>
          kind === 'error' ? toast.error(message) : toast.success(message),
      });
      return true;
    },
    [renameMutate, sessionId]
  );

  return { tryRun };
}
