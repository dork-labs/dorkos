'use client';

import { Avatar } from './Avatar';
import { CAST } from './cast';
import { agentLayoutId } from './chat-script';
import { PANEL } from './film-tokens';

interface ChatHeaderProps {
  /** Whether the agents have joined the room. */
  joined: boolean;
  /**
   * Whether this header is the one the hero cards fly into.
   *
   * Exactly one may be. The storyboard's frames carry the same faces without
   * the shared layout id, so each is a picture of the room rather than another
   * claim on the same three agents.
   */
  flights?: boolean;
}

/**
 * Chat header: room name, Dave (always present), and the agents' member faces.
 * The faces share layout ids with the hero cards, so flipping `joined` makes
 * them physically fly from their cards into this row, and back.
 */
export function ChatHeader({ joined, flights = true }: ChatHeaderProps) {
  return (
    <div
      className="flex shrink-0 items-center justify-between px-3 py-1.5 sm:px-4 sm:py-2.5"
      style={{ borderBottom: `1px solid ${PANEL.divider}` }}
    >
      <span
        className="text-2xs font-mono tracking-[0.12em] uppercase"
        style={{ color: PANEL.textMuted }}
      >
        # launch-day
      </span>
      <div className="flex h-7 items-center -space-x-1.5 sm:h-8">
        <span className="relative z-10">
          <Avatar who="dave" size={26} ringed />
        </span>
        {joined &&
          CAST.map((member) => (
            <Avatar
              key={member.key}
              who={member.key}
              size={26}
              layoutId={flights ? agentLayoutId(member.key) : undefined}
            />
          ))}
      </div>
    </div>
  );
}
