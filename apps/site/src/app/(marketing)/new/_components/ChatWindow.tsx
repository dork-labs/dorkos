'use client';

import { ChatHeader } from './ChatHeader';
import { ChatMessage } from './ChatMessage';
import type { ChatLine } from './chat-script';
import { filmPx, PANEL } from './film-tokens';

/** The brand hairline across the top of the panel, 5px on the film's canvas. */
const HAIRLINE_PX = filmPx(5);

/**
 * The fade that eats the departing message instead of guillotining it, 70px on
 * the film's canvas. Its own file's comments disagree about the length; the
 * code says 70 and the code is what shipped.
 */
const FADE = `linear-gradient(to bottom, transparent 0, #000 ${filmPx(70)}px, #000 100%)`;

interface ChatWindowProps {
  /** Whether the agents have joined the room. */
  joined: boolean;
  /** Lines already said. */
  lines: readonly ChatLine[];
  /** The line currently being typed, if any. */
  pending: ChatLine | null;
}

/**
 * The live chat card, in the film's own clothes: a dark glass panel with the
 * brand's orange hairline across the top.
 *
 * It stays dark on a cream page on purpose. Dave's office is 1999 and the
 * DorkOS chat is not — that contrast is the film's whole argument, and the
 * moment the product UI looks period the page says "this software is old"
 * instead of "even this guy can do this".
 *
 * The message stack is the film's trick and it ports for free: a clipped box
 * with `justify-content: flex-end` means each new message pushes the others up
 * and off the top with no height arithmetic anywhere, and the gradient mask
 * fades the departing message instead of guillotining it.
 *
 * Said and pending lines render as one keyed list so the pending row keeps its
 * identity when it resolves: the same element flips from typing dots to text,
 * which is what makes the dots appear to morph into the message.
 */
export function ChatWindow({ joined, lines, pending }: ChatWindowProps) {
  const rows = pending ? [...lines, pending] : lines;
  const lastIndex = rows.length - 1;

  return (
    <div
      className="w-full overflow-hidden rounded-xl shadow-[0_18px_60px_rgba(26,24,20,0.28)] backdrop-blur-md"
      style={{ background: PANEL.surface, border: `1px solid ${PANEL.border}` }}
    >
      {/* The brand signature, and the panel's only ornament. */}
      <div style={{ height: HAIRLINE_PX, background: PANEL.hairline }} />
      <ChatHeader joined={joined} />
      <div
        className="flex h-[42vh] max-h-[420px] min-h-[300px] flex-col justify-end gap-2 overflow-hidden px-4 pt-4 pb-5"
        style={{
          maskImage: FADE,
          WebkitMaskImage: FADE,
        }}
        aria-hidden="true"
      >
        {rows.map((line, i) => (
          <ChatMessage key={`line-${i}`} line={line} revealed={!(pending && i === lastIndex)} />
        ))}
      </div>
    </div>
  );
}
