/**
 * What a screen reader hears when a permission request gets its answer.
 *
 * This has to live ABOVE the card. The card is the obvious place to announce
 * from and the wrong one: answering it resolves the interaction, which clears
 * the input zone, which unmounts the card — so a live region inside it is
 * removed in the same commit that writes the sentence, and nothing is ever
 * read. The transcript outlives every card in it, so the announcement belongs
 * with the transcript.
 *
 * @module features/chat/model/stream/use-approval-announcer
 */
import { useEffect, useRef, useState } from 'react';
import type { MessagePart } from '@dorkos/shared/types';
import { getToolLabel } from '@/layers/shared/lib';

/**
 * How long an announcement stays in the region before it is cleared.
 *
 * Same discipline as `useStreamingAnnouncer`: a live region only speaks when
 * its contents CHANGE, so one left holding its last sentence is silent until a
 * remount reads the whole thing out. The region spends its life empty.
 */
const CLEAR_MS = 4000;

/** The sentence for one answered request. */
function sentenceFor(part: Extract<MessagePart, { type: 'tool_call' }>): string {
  const label = part.approvalDisplayName || getToolLabel(part.toolName, part.input ?? '');
  if (part.approvalOutcome === 'allowed') return `Allowed ${label}. Recorded in the conversation.`;
  if (part.approvalOutcome === 'denied') return `Denied ${label}. Recorded in the conversation.`;
  return `${label} expired without an answer and was denied. Recorded in the conversation.`;
}

/**
 * The sentence to put in the transcript's approval-resolution region right now.
 *
 * **It only speaks about answers it watched land.** Everything already answered
 * when the hook mounts is adopted silently — otherwise opening a conversation,
 * or switching back to one, would read out every decision the session has ever
 * recorded.
 *
 * Only the transcript's last message is examined. A newly answered request is
 * always on the turn in flight, which is the trailing bubble; older messages
 * carry answers that are history, not news — and scanning them every render
 * would cost the length of the conversation for nothing.
 *
 * @param tailParts - Parts of the transcript's last message.
 * @returns The sentence for the region, or `''` when there is nothing to say.
 */
export function useApprovalAnnouncer(tailParts: MessagePart[]): string {
  // Tool-call ids whose answer has already been accounted for — announced, or
  // adopted silently at mount.
  const seenRef = useRef<Set<string> | null>(null);
  // The region's contents plus a nonce: two identical sentences in a row are
  // the same DOM text, which React does not touch and no screen reader repeats.
  const [announcement, setAnnouncement] = useState({ text: '', nonce: 0 });

  useEffect(() => {
    const answered = tailParts.filter(
      (part) => part.type === 'tool_call' && part.approvalOutcome !== undefined
    ) as Extract<MessagePart, { type: 'tool_call' }>[];
    // First pass: adopt whatever is already answered without saying any of it.
    if (seenRef.current === null) {
      seenRef.current = new Set(answered.map((part) => part.toolCallId));
      return;
    }
    const fresh = answered.filter((part) => !seenRef.current!.has(part.toolCallId));
    if (fresh.length === 0) return;
    for (const part of fresh) seenRef.current.add(part.toolCallId);
    // A batch answer lands several at once; say how many rather than reciting
    // a list nobody asked to hear.
    const text =
      fresh.length === 1
        ? sentenceFor(fresh[0])
        : `Answered ${fresh.length} permission requests. Recorded in the conversation.`;
    setAnnouncement((prev) => ({ text, nonce: prev.nonce + 1 }));
  }, [tailParts]);

  // Empty at rest — the state the region must be in for a remount to be silent.
  useEffect(() => {
    if (announcement.text === '') return;
    const clear = setTimeout(
      () => setAnnouncement((prev) => ({ text: '', nonce: prev.nonce })),
      CLEAR_MS
    );
    return () => clearTimeout(clear);
  }, [announcement]);

  if (announcement.text === '') return '';
  // Zero-width, so the alternation is heard by nothing and shown by nothing.
  return announcement.nonce % 2 === 0 ? announcement.text : `${announcement.text}\u200B`;
}
