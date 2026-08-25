'use client';

import { motion } from 'motion/react';
import { ChatHeader } from './ChatHeader';
import { ChatMessage } from './ChatMessage';
import type { ChatLine } from './chat-script';

interface ChatWindowProps {
  /** Whether the agents have joined the room. */
  joined: boolean;
  /** Lines already said. */
  lines: readonly ChatLine[];
  /** The line currently being typed, if any. */
  pending: ChatLine | null;
}

/**
 * The live chat card — the one graphic the whole page revolves around. The
 * agents fly into its header, the apps fly into its messages, and the laptop
 * later forms around it.
 *
 * Said and pending lines render as one keyed list so the pending row keeps its
 * identity when it resolves: the same element flips from typing dots to text,
 * which is what makes the dots appear to morph into the message.
 */
export function ChatWindow({ joined, lines, pending }: ChatWindowProps) {
  const rows = pending ? [...lines, pending] : lines;
  const lastIndex = rows.length - 1;

  return (
    <div className="w-full overflow-hidden rounded-2xl border border-(--line) bg-(--panel) shadow-[0_24px_80px_rgba(0,0,0,0.5)]">
      <ChatHeader joined={joined} />
      <div
        className="flex h-[42vh] max-h-[420px] min-h-[300px] flex-col justify-end gap-3 overflow-hidden px-5 py-5"
        aria-hidden="true"
      >
        {rows.map((line, i) => (
          <motion.div
            key={`line-${i}`}
            layout
            initial={{ opacity: 0, y: 26, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            style={{ transformOrigin: 'bottom left' }}
          >
            <ChatMessage line={line} revealed={!(pending && i === lastIndex)} />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
