/**
 * One session's live verb, subscribed to at the leaf.
 *
 * This component is the whole of the sidebar's central performance decision
 * (spec R1). A fleet of thirty agents emits a tool reading every couple of
 * seconds each; if that text lived on the sidebar model, every one of those
 * readings would rebuild the model, re-run the zone rules and re-render sixty
 * rows to change four characters in one of them. So it does not live there. The
 * model carries `reservesVerbLine`, derived from lifecycle, which changes when
 * a turn starts and stops — and this leaf, mounted inside the row it describes,
 * carries the words.
 *
 * The split in one line: **layout stability comes from lifecycle, text comes
 * from activity.**
 *
 * It lives in `entities/session` rather than beside `SidebarRow` because that
 * is where the store is, and `shared/` may not reach up a layer to find it. The
 * row takes it as a `secondLine` node — the same shape it already takes a face
 * as a `glyph` — so `shared/` never learns what a session is.
 *
 * @module entities/session/ui/SessionVerbLine
 */
import type { ReactNode } from 'react';
import type { SessionLifecycle } from '@dorkos/shared/session-stream';
import { activityVerb } from '@/layers/shared/lib';
import { useSessionToolActivity } from '../model/session-list-store';

/** Props for {@link SessionVerbLine}. */
export interface SessionVerbLineProps {
  /** The session to watch. */
  sessionId: string;
  /**
   * The session's coarse phase, from the caller's model.
   *
   * A PROP, not a second subscription, and that is the point of the whole
   * arrangement: the lifecycle is already in the sidebar model (it is what
   * decides `status` and `reservesVerbLine`), so reading it again here would
   * subscribe this leaf to the churn the model was built to absorb. The only
   * thing this component subscribes to is the one field the model refuses to
   * hold.
   */
  lifecycle: SessionLifecycle | null | undefined;
}

/**
 * What this session is doing right now, in the words of the honesty ladder — or
 * nothing at all when it is not doing anything.
 *
 * Renders bare text. The row that hosts it owns the styling of its second line,
 * so a verb, a preview and a room's last message all read as one line rather
 * than as three components that agreed about a font size.
 *
 * @param props - The session to watch and its lifecycle.
 */
export function SessionVerbLine({ sessionId, lifecycle }: SessionVerbLineProps): ReactNode {
  const activity = useSessionToolActivity(sessionId);
  return activityVerb(lifecycle, activity);
}
