import { useState } from 'react';
import type { AgentVisual } from '@/layers/shared/lib';

/** An agent identity the bar can draw: a name and the face that goes with it. */
export interface LastKnownAgent {
  /** The agent's display name, or `undefined` if none has been seen. */
  name: string | undefined;
  /** The matching visual, held and released together with the name. */
  visual: AgentVisual | undefined;
}

/**
 * The agent identity to draw, holding the last one seen for this session.
 *
 * An agent can be deleted or unregistered while you are still reading the
 * conversation it was having (spec §5.3). Without this, the moment its record
 * goes the bar swaps to a folder icon and a directory name — the session on
 * screen is unchanged, every word in it is still that agent's, and the header
 * stops being able to say who wrote them. Holding the last-known identity is
 * the honest answer: it was this agent, and it still was a second ago.
 *
 * **Scoped to one session, which is the whole reason it takes a key.** A hold
 * with no key is a leak: open a session with an agent, then open a bare
 * directory session, and the bar would confidently label the second
 * conversation with the first one's agent. The held identity is dropped the
 * moment the session changes, so a hold can only ever outlive the agent — never
 * the conversation it was about.
 *
 * **Name and visual are held as one.** They are two halves of one identity, so
 * releasing them separately could pair a live name with a stale face — which is
 * worse than either being stale, because it looks correct.
 *
 * A rename needs nothing from this: the new name arrives and replaces the old,
 * which is already what the bar should show.
 *
 * @param sessionId - The session being read; changing it drops the hold.
 * @param name - The agent's display name right now, absent when there is none.
 * @param visual - The agent's resolved visual right now, absent likewise.
 */
export function useLastKnownAgent(
  sessionId: string | undefined,
  name: string | undefined,
  visual: AgentVisual | undefined
): LastKnownAgent {
  // The "adjusting state while rendering" pattern: no effect, so there is never
  // a frame painted with the previous session's agent before a cleanup runs.
  const [held, setHeld] = useState<LastKnownAgent>({ name, visual });
  const [heldFor, setHeldFor] = useState<string | undefined>(sessionId);

  if (heldFor !== sessionId) {
    setHeldFor(sessionId);
    setHeld({ name, visual });
    return { name, visual };
  }

  if (name !== undefined && (name !== held.name || visual !== held.visual)) {
    setHeld({ name, visual });
    return { name, visual };
  }

  return held;
}
