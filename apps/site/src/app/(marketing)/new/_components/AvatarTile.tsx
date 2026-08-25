'use client';

import { motion } from 'motion/react';
import { HumanFace } from './avatars';
import type { Sender } from './chat-script';
import { AGENTS_BY_KEY } from './cast';
import { POP } from './motion-tokens';

/** Avatar tile scale: `lg` on hero cards, `md` in the chat. */
type TileSize = 'lg' | 'md';

const TILE_SIZES: Record<TileSize, string> = {
  lg: 'size-12 rounded-xl',
  md: 'size-9 rounded-lg',
};
const FACE_SIZES: Record<TileSize, number> = { lg: 40, md: 30 };
const BADGE_TILES: Record<TileSize, string> = { lg: 'size-5', md: 'size-4' };
const BADGE_ICONS: Record<TileSize, number> = { lg: 10, md: 8 };

interface AvatarTileProps {
  sender: Sender;
  size?: TileSize;
  /**
   * Shared-element id. Give the hero card and the chat header the same id and
   * the avatar physically flies between them when one of the two unmounts.
   */
  layoutId?: string;
}

/**
 * Slack-style avatar tile: a cartoon face on a tinted rounded square, with the
 * agent's runtime mark as a corner sub-badge. Human senders get no badge.
 */
export function AvatarTile({ sender, size = 'md', layoutId }: AvatarTileProps) {
  const agent = sender === 'you' || sender === 'system' ? null : AGENTS_BY_KEY[sender];
  const title = agent ? `${agent.name} · ${agent.runtime}` : 'You';
  const face = (
    <>
      <span
        className={`grid ${TILE_SIZES[size]} place-items-center overflow-hidden`}
        style={{ backgroundColor: agent ? `${agent.color}24` : 'rgba(232,93,4,0.16)' }}
      >
        {agent ? <agent.Face size={FACE_SIZES[size]} /> : <HumanFace size={FACE_SIZES[size]} />}
      </span>
      {agent && (
        <span
          className={`absolute -right-1 -bottom-1 grid ${BADGE_TILES[size]} place-items-center rounded-full bg-(--panel-raised) ring-2 ring-(--panel)`}
          style={{ color: agent.runtimeColor }}
        >
          <agent.RuntimeLogo size={BADGE_ICONS[size]} />
        </span>
      )}
    </>
  );

  if (!layoutId) {
    return (
      <span className="relative inline-block shrink-0" title={title}>
        {face}
      </span>
    );
  }
  return (
    <motion.span
      layoutId={layoutId}
      transition={POP}
      className="relative inline-block shrink-0"
      title={title}
    >
      {face}
    </motion.span>
  );
}
