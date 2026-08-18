/**
 * The seam between one row's chrome and what is actually inside it.
 *
 * The row unifies; the CONTENT does not. A session message is a list of
 * `MessagePart`s — text, tool calls, thinking, inline prompts — and a room entry
 * is markdown with mention pills spliced through it. Forcing those into one type
 * would merge two things that have nothing in common but the fact that somebody
 * said them, so each host keeps its own renderer and the compound never learns
 * which one it got.
 *
 * @module features/conversation/model/body-renderer
 */
import type { ReactNode } from 'react';

/** What a renderer is told about the row it is drawing. */
export interface BodyRenderContext {
  /** The row this body belongs to. */
  rowId: string;
  /** True while this row is the streaming tail. */
  isStreaming: boolean;
}

/** Turns one message row's opaque payload into its rendered body. */
export type ConversationBodyRenderer = (payload: unknown, ctx: BodyRenderContext) => ReactNode;
