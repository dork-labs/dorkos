'use client';

import { AvatarTile } from './AvatarTile';
import { agentLayoutId } from './chat-script';
import { CAST } from './cast';

/**
 * Chat header: room name, you (always present), and the agents' member tiles.
 * The tiles share layout ids with the hero cards, so flipping `joined` makes
 * the robots physically fly from their cards into this row — and back.
 */
export function ChatHeader({ joined }: { joined: boolean }) {
  return (
    <div className="flex items-center justify-between border-b border-(--line) px-5 py-3">
      <span className="text-2xs font-mono tracking-[0.15em] text-(--cream-dim) uppercase">
        # launch-day
      </span>
      <div className="flex h-9 items-center -space-x-2">
        <span className="relative z-10">
          <AvatarTile sender="you" />
        </span>
        {joined &&
          CAST.map((agent) => (
            <AvatarTile key={agent.key} sender={agent.key} layoutId={agentLayoutId(agent.key)} />
          ))}
      </div>
    </div>
  );
}
