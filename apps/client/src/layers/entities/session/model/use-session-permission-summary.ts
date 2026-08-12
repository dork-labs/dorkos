/**
 * A session's permission mode, and whether that mode means "ask nobody".
 *
 * Three surfaces need the same two facts about one session — the full row draws
 * a shield when the answer is unsafe, the details panel names the mode in words,
 * and the sidebar-grammar row does both — and each of them used to derive it
 * from the same four steps. Deriving it once is what keeps the shield and the
 * word underneath it from ever disagreeing.
 *
 * @module entities/session/model/use-session-permission-summary
 */
import type { PermissionMode, Session } from '@dorkos/shared/types';
import { isBypassPermissionMode, isBypassSemantics } from '@/layers/shared/lib';
import { useCapabilitiesForRuntime } from '@/layers/entities/runtime';
import { useSessionPermissionMode } from './use-session-detail';

/** What {@link useSessionPermissionSummary} answers. */
export interface SessionPermissionSummary {
  /** The mode id the session is running under. */
  permissionMode: PermissionMode;
  /** The mode lets the agent act without asking first. */
  isUnsafe: boolean;
}

/**
 * Read a session's permission mode and classify it, without fetching.
 *
 * **Read-only on purpose.** `enabled: false` means a rail of fifty rows
 * subscribes to the session cache without any of them fetching, and a row still
 * picks up a mode change the instant it is made in the status line — the list it
 * is rendered from only refreshes when the server says so.
 *
 * The classification asks what the mode DOES rather than what it is called. The
 * capability map is one `staleTime: Infinity` query the shell has already
 * mounted, so a rail of fifty rows shares a single lookup; the name-based
 * fallback answers for the frames before the map lands, which is the same answer
 * for every runtime shipped today.
 *
 * @param session - The session to summarise.
 */
export function useSessionPermissionSummary(session: Session): SessionPermissionSummary {
  const permissionMode =
    useSessionPermissionMode(session.id, {
      enabled: false,
      // `session.permissionMode` carries any id the session's own runtime
      // reports (DOR-851; `test-mode`'s ids sit outside the enum on purpose).
      // Safe to narrow back to `PermissionMode` here — every reader treats it as
      // an opaque display string (`permissionModeLabel`,
      // `isBypassPermissionMode`) or looks it up in the runtime's own descriptor
      // map, never against the literal enum.
      fallback: session.permissionMode as PermissionMode,
    }) ?? 'default';
  const caps = useCapabilitiesForRuntime(session.runtime);
  const descriptor = caps?.permissionModes.values.find((d) => d.id === permissionMode);
  const isUnsafe = descriptor
    ? isBypassSemantics(descriptor)
    : isBypassPermissionMode(permissionMode);

  return { permissionMode, isUnsafe };
}
