'use client';

import { AvatarTile, CAST, HumanFace, NIGHT_VARS, type CastMember } from '../../../new/_components';

/** A dark tile so the cast is judged against the background they live on. */
function DarkCard({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={NIGHT_VARS}
      className="flex flex-col items-center gap-4 rounded-xl border border-(--line) bg-(--panel) p-6"
    >
      {children}
    </div>
  );
}

function CastMember({ agent }: { agent: CastMember }) {
  return (
    <DarkCard>
      <span
        className="grid size-24 place-items-center rounded-2xl"
        style={{ backgroundColor: `${agent.color}24` }}
      >
        <agent.Face size={80} />
      </span>
      <div className="text-center">
        <p className="text-base font-semibold text-(--cream)">{agent.name}</p>
        <p className="text-2xs font-mono tracking-[0.1em] text-(--cream-dim) uppercase">
          {agent.runtime}
        </p>
      </div>
      <div className="flex items-end gap-4">
        <AvatarTile sender={agent.key} size="lg" />
        <AvatarTile sender={agent.key} size="md" />
      </div>
      <p className="font-mono text-xs text-(--cream-dim)">
        {agent.color} · badge {agent.runtimeColor}
      </p>
    </DarkCard>
  );
}

/**
 * The cast at working size: the cartoon faces, the avatar tiles they become in
 * the chat, and the runtime badge that identifies which agent runs them.
 */
export function CastGallery() {
  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
      {CAST.map((agent) => (
        <CastMember key={agent.key} agent={agent} />
      ))}
      <DarkCard>
        <span className="grid size-24 place-items-center rounded-2xl bg-[rgba(232,93,4,0.16)]">
          <HumanFace size={80} />
        </span>
        <div className="text-center">
          <p className="text-base font-semibold text-(--cream)">You</p>
          <p className="text-2xs font-mono tracking-[0.1em] text-(--cream-dim) uppercase">
            the person
          </p>
        </div>
        <div className="flex items-end gap-4">
          <AvatarTile sender="you" size="lg" />
          <AvatarTile sender="you" size="md" />
        </div>
        <p className="font-mono text-xs text-(--cream-dim)">no runtime badge</p>
      </DarkCard>
    </div>
  );
}
