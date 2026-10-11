/**
 * Which kind of wait each blocking event is, in the room's vocabulary: what a
 * room turn tells the room when it sits on a prompt.
 *
 * @module services/rooms/turn-guards/waiting-kinds
 */
import type { BlockingInteractionEventType } from '@dorkos/shared/session-stream';
import type { RoomTurnWaiting } from '../room-trigger.js';

/**
 * Which kind of wait each blocking event is, in the room's vocabulary.
 *
 * A total map over {@link BlockingInteractionEventType} rather than a chain of
 * comparisons: a fourth way to park a turn on a person would be a type error
 * here rather than a room that silently stopped mentioning it.
 */
export const WAITING_KINDS: Record<BlockingInteractionEventType, RoomTurnWaiting['kind']> = {
  approval_required: 'approval',
  question_prompt: 'question',
  elicitation_prompt: 'elicitation',
};
