/**
 * What a resolved interaction leaves the tool call it gated, for the live fold.
 *
 * @module features/chat/model/stream/resolved-tool-status
 */
import type { InteractionResolvedEvent } from '@dorkos/shared/session-stream';

/** The resolution kinds an interaction can settle with. */
type InteractionResolution = NonNullable<InteractionResolvedEvent['resolution']>;

/**
 * The settled tool-part status for a resolution outcome.
 *
 * @param resolution - How the interaction ended, when the server said.
 */
export function resolvedToolStatus(
  resolution: InteractionResolution | undefined
): 'running' | 'complete' | 'error' {
  if (resolution === 'denied') return 'error';
  // Expired / cancelled (no operator action): the gated tool never ran and no
  // real tool_result is guaranteed to follow — settle as error.
  if (resolution === 'expired' || resolution === 'cancelled') return 'error';
  if (resolution === 'answered') return 'complete';
  // Approved (or unknown): the tool is now executing; the following
  // tool_result event carries the real terminal status.
  return 'running';
}
