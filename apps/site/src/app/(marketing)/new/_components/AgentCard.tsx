'use client';

import { motion } from 'motion/react';
import { REVEAL } from '@/layers/features/marketing';
import { Avatar } from './Avatar';
import { RUNTIMES, type CastKey, type CastMember } from './cast';
import { agentLayoutId } from './chat-script';

const FLOAT_BASE_S = 3.6;
const FLOAT_STAGGER_S = 0.7;

interface AgentCardProps {
  agent: CastMember<CastKey>;
  /** Position in the row, used to desynchronise the floating. */
  index: number;
  /** True once this agent has flown into the chat, leaving an empty seat. */
  joined: boolean;
  /** Off-screen cards stop floating: an idle animation still costs a frame. */
  floating: boolean;
}

/**
 * A floating agent card in the hero. Its face shares a layout id with the chat
 * header, so the agent physically leaves this card when the chat opens.
 *
 * The runtime badge is the point of the card. Otto, Pip and Hal are the film's
 * characters, but what they are standing for here is Claude Code, Codex and
 * OpenCode running side by side in one window, which is the whole differentiator.
 */
export function AgentCard({ agent, index, joined, floating }: AgentCardProps) {
  const { runtime, RuntimeLogo, runtimeColor } = RUNTIMES[agent.key];

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
        className="border-border-warm bg-cream-white flex items-center gap-3.5 rounded-2xl border py-3.5 pr-6 pl-4 shadow-[0_12px_36px_rgba(26,24,20,0.10)]"
      >
        {joined ? (
          <span
            className="border-border-warm size-12 shrink-0 rounded-full border border-dashed"
            title={`${agent.name} is in the chat`}
          />
        ) : (
          <Avatar who={agent.key} size={48} layoutId={agentLayoutId(agent.key)} />
        )}
        <span className={joined ? 'text-left opacity-50' : 'text-left'}>
          <span className="text-charcoal block text-sm font-medium">{agent.name}</span>
          <span className="text-2xs text-warm-gray-light flex items-center gap-1 font-mono tracking-[0.08em] uppercase">
            <span className="shrink-0" style={{ color: runtimeColor }}>
              <RuntimeLogo size={10} />
            </span>
            {runtime}
          </span>
        </span>
      </motion.div>
    </motion.li>
  );
}
