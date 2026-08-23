/**
 * A session's permission mode, and whether that mode means "ask nobody".
 *
 * Three surfaces need the same two facts about one session — the full row marks
 * the answer on its face, the details panel names the mode in words, and the
 * sidebar-grammar row does both — and each of them used to derive it from the
 * same four steps. Deriving it once is what keeps the mark and the word
 * underneath it from ever disagreeing.
 *
 * ## What the mark looks like is not decided here
 *
 * It used to be a red shield, and it is now a green bolt: full power is a
 * setting a person chose, not an incident, and red is kept for genuine alarms
 * (spec `full-power-defaults`, D8). The colour comes from `TRUST_TONE_TEXT` in
 * `shared/ui/trust-tone`, the one table every trust surface reads, so this hook
 * stays about the FACT and the rows stay about the drawing.
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
  // ── A split worth knowing about ──
  //
  // Whether a row is MARKED is decided here by `isBypassSemantics` (never asks
  // AND reaches everything). What colour the mark reads is decided by
  // `trustTone` in `shared/ui/trust-tone`, which asks `isAutonomyStop` — where
  // the mode SITS on the dial. The two predicates are allowed to disagree and
  // `permission-semantics` says so deliberately.
  //
  // Today no shipped runtime makes them disagree: every declared autonomy stop
  // also reaches everything. The day one declares a SANDBOXED autonomy stop, the
  // dial and the status strip would go green for it while this row stayed
  // unmarked — the same session described two ways in two places. That is the
  // moment to reconcile them, and the choice is one predicate for both, not a
  // third one here.
  const isUnsafe = descriptor
    ? isBypassSemantics(descriptor)
    : isBypassPermissionMode(permissionMode);

  return { permissionMode, isUnsafe };
}
