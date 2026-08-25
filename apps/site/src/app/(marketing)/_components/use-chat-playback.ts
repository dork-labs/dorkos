'use client';

import { useEffect, useState } from 'react';
import { CHAT_SCRIPT, isAgentLine, type ChatLine, type Sender } from './chat-script';

const GAP_MS = 700;
const TYPING_MS = 1000;

/** What the chat should render right now. */
export interface ChatPlayback {
  /** Lines already said. */
  lines: readonly ChatLine[];
  /** The line currently being typed, shown as dots that morph into it. */
  pending: ChatLine | null;
}

/**
 * Plays the script up to `target` lines, pausing on typing dots before each
 * agent's turn. Raising `target` resumes; it never rewinds, so scrolling back
 * and forth doesn't replay the conversation.
 *
 * @param target - How many lines should be visible by now.
 */
export function useChatPlayback(target: number): ChatPlayback {
  const [visible, setVisible] = useState(0);
  const [typing, setTyping] = useState<Sender | null>(null);

  useEffect(() => {
    if (visible >= target) return;
    const line = CHAT_SCRIPT[visible];
    const advance = () => {
      setTyping(null);
      setVisible((v) => v + 1);
    };
    let id: ReturnType<typeof setTimeout>;
    if (!isAgentLine(line)) {
      id = setTimeout(advance, GAP_MS);
    } else if (typing === null) {
      id = setTimeout(() => setTyping(line.from), GAP_MS);
    } else {
      id = setTimeout(advance, TYPING_MS);
    }
    return () => clearTimeout(id);
  }, [visible, typing, target]);

  return {
    lines: CHAT_SCRIPT.slice(0, visible),
    pending: typing !== null && visible < target ? CHAT_SCRIPT[visible] : null,
  };
}
