'use client';

import { motion } from 'motion/react';
import { Avatar } from './Avatar';
import { senderColor, senderName, type ChatLine } from './chat-script';
import { DockBadge } from './DockBadge';
import { PANEL } from './film-tokens';
import { SystemMessage } from './SystemMessage';
import { TypingDots } from './TypingDots';

interface ChatMessageProps {
  line: ChatLine;
  /** When false, the bubble shows typing dots that morph into the text. */
  revealed: boolean;
}

/**
 * `usePop` from the film, as a motion keyframe.
 *
 * The film's entrances are multi-stop linear interpolations, never springs, so
 * they port with exact fidelity rather than approximately: 0.86 -> 1.04 -> 1
 * over 11 frames at 30fps, which is 367ms with the overshoot at 200ms.
 */
const POP_IN = {
  initial: { opacity: 0, scale: 0.86 },
  animate: { opacity: 1, scale: [0.86, 1.04, 1] },
  transition: {
    scale: { duration: 0.367, times: [0, 0.545, 1], ease: 'linear' as const },
    opacity: { duration: 0.2, ease: 'linear' as const },
  },
};

/**
 * One chat row: face, name, bubble.
 *
 * Dave mirrors to the right and his bubble fills with the brand orange; the
 * agents sit left with a dark card. That one colour split is the whole
 * legibility argument in the film, and it is why nobody needs to be told which
 * of the four is the person.
 *
 * The transform origin is load-bearing. A bubble that scales from its own
 * bottom corner reads as landing next to its avatar; one that scales from the
 * centre reads as a modal opening.
 */
export function ChatMessage({ line, revealed }: ChatMessageProps) {
  if (line.from === 'system') {
    return <SystemMessage line={line} />;
  }

  const own = line.from === 'dave';

  return (
    <motion.div
      layout
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.2, ease: 'linear' }}
      className={`flex items-end gap-2.5 ${own ? 'flex-row-reverse' : 'flex-row'}`}
    >
      <Avatar who={line.from} size={30} ringed={own} />
      <div className={`flex min-w-0 flex-col gap-1 ${own ? 'items-end' : 'items-start'}`}>
        <span
          className="text-3xs px-1 font-mono font-semibold tracking-[0.14em] uppercase"
          style={{ color: senderColor(line.from) }}
        >
          {senderName(line.from)}
        </span>
        {/*
          The pop sits on the bubble, not on the row. Putting it on the row let
          motion's layout projection resolve the transform origin to the row's
          centre, and a bubble that scales from the centre reads as a modal
          opening rather than as a message landing beside its avatar.
        */}
        <motion.div
          {...POP_IN}
          className="max-w-[34ch] px-3 py-2 text-[13px] leading-[1.28] font-semibold tracking-[-0.01em] text-pretty sm:text-[15px]"
          style={{
            transformOrigin: own ? 'right bottom' : 'left bottom',
            background: own ? PANEL.own : PANEL.bubble,
            color: PANEL.text,
            border: own ? 'none' : `1px solid ${PANEL.bubbleBorder}`,
            borderRadius: 9,
            [own ? 'borderBottomRightRadius' : 'borderBottomLeftRadius']: 3,
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
          }}
        >
          {revealed ? (
            <span>
              {line.dockApp && <DockBadge id={line.dockApp} />}
              {line.mention && (
                <span className="rounded bg-[rgba(255,255,255,0.16)] px-1 py-0.5">
                  {line.mention}
                </span>
              )}
              {line.mention ? ' ' : null}
              {line.text}
            </span>
          ) : (
            <TypingDots />
          )}
        </motion.div>
      </div>
    </motion.div>
  );
}
