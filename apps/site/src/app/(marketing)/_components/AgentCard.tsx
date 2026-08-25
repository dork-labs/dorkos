'use client';

import { motion } from 'motion/react';
import { REVEAL } from '@/layers/features/marketing';
import { AvatarTile } from './AvatarTile';
import { agentLayoutId } from './chat-script';
import type { FleetAgent } from './fleet';

const FLOAT_BASE_S = 3.6;
const FLOAT_STAGGER_S = 0.7;

interface AgentCardProps {
  agent: FleetAgent;
  /** Position in the row, used to desynchronise the floating. */
  index: number;
  /** True once this agent has flown into the chat, leaving an empty seat. */
  joined: boolean;
  /** Off-screen cards stop floating: an idle animation still costs a frame. */
  floating: boolean;
}

/**
 * A floating agent card in the hero. Its avatar shares a layout id with the
 * chat header, so the robot physically leaves this card when the chat opens.
 */
export function AgentCard({ agent, index, joined, floating }: AgentCardProps) {
  return (
    <motion.li variants={REVEAL}>
      <motion.div
        animate={floating ? { y: [0, -9, 0] } : { y: 0 }}
        transition={
          floating
            ? {
                duration: FLOAT_BASE_S + index,
                repeat: Infinity,
                ease: 'easeInOut',
                delay: index * FLOAT_STAGGER_S,
              }
            : { duration: 0.3 }
        }
        className="flex items-center gap-3.5 rounded-2xl border border-(--line) bg-(--panel) py-3.5 pr-6 pl-4 shadow-[0_16px_48px_rgba(0,0,0,0.4)]"
      >
        {joined ? (
          <span
            className="size-12 shrink-0 rounded-xl border border-dashed border-(--line)"
            title={`${agent.name} is in the chat`}
          />
        ) : (
          <AvatarTile sender={agent.key} size="lg" layoutId={agentLayoutId(agent.key)} />
        )}
        <span className={joined ? 'text-left opacity-50' : 'text-left'}>
          <span className="block text-sm font-medium text-(--cream)">{agent.name}</span>
          <span className="text-2xs block font-mono tracking-[0.08em] text-(--cream-dim) uppercase">
            {agent.runtime}
          </span>
        </span>
      </motion.div>
    </motion.li>
  );
}
