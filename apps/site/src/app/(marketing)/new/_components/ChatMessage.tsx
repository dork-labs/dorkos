'use client';

import { motion } from 'motion/react';
import { AvatarTile } from './AvatarTile';
import { senderColor, senderName, type ChatLine } from './chat-script';
import { DockBadge } from './DockBadge';
import { POP } from './motion-tokens';
import { SystemMessage } from './SystemMessage';
import { TypingDots } from './TypingDots';

interface ChatMessageProps {
  line: ChatLine;
  /** When false, the bubble shows typing dots that morph into the text. */
  revealed: boolean;
}

/** One Slack-style chat row: avatar, name, timestamp, message. */
export function ChatMessage({ line, revealed }: ChatMessageProps) {
  if (line.from === 'system') {
    return <SystemMessage line={line} />;
  }
  return (
    <div className="flex items-start gap-3">
      <AvatarTile sender={line.from} />
      <div className="min-w-0 text-left">
        <p className="flex items-baseline gap-2">
          <span className="text-sm font-semibold" style={{ color: senderColor(line.from) }}>
            {senderName(line.from)}
          </span>
          <span className="text-2xs font-mono text-(--cream-dim)">{line.time} AM</span>
        </p>
        <motion.div
          layout
          transition={POP}
          className="mt-0.5 text-sm text-(--cream) sm:text-[15px]"
        >
          {revealed ? (
            <span>
              {line.dockApp && <DockBadge id={line.dockApp} />}
              {line.mention && (
                <span className="rounded bg-[rgba(111,168,220,0.16)] px-1 py-0.5 font-medium text-[#8ec1ee]">
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
    </div>
  );
}
