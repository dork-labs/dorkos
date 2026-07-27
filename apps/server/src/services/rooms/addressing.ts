/**
 * Who a committed post should trigger (spec `rooms` §5).
 *
 * Pure — no database, no clock, no runtime. It answers one question about one
 * entry and a roster, which is what makes the matrix below testable in full.
 *
 * Addressing three agents and getting three answers is the intended outcome,
 * not a pathology. `responseMode` exists to stop an agent answering when it was
 * NOT addressed; it makes no attempt to order or serialise the ones who were.
 * Bounding a conversation that feeds itself is the cascade guard's job
 * (`cascade-guard.ts`), and it runs after this.
 *
 * `room-trigger.ts` is the production caller.
 *
 * @module server/services/rooms/addressing
 */
import type { ResponseMode } from '@dorkos/shared/mesh-schemas';
import type { AuthorKind, RoomKind } from '@dorkos/shared/room-schemas';

/** One member as addressing sees it. */
export interface AddressingMember {
  authorId: string;
  /** Only `agent` members are ever triggered. */
  kind: AuthorKind;
  /** This room's stored override, not the manifest default. */
  responseMode: ResponseMode;
}

/** The entry being addressed. */
export interface AddressingEntry {
  authorId: string;
  /** Author ids resolved from `@name` at write time. */
  mentions: readonly string[];
}

/**
 * Whether one `responseMode` answers this entry in this kind of room.
 *
 * | mode           | triggered when                                   |
 * | -------------- | ------------------------------------------------ |
 * | `silent`       | never                                            |
 * | `mention-only` | mentioned                                        |
 * | `direct-only`  | the room is a DM, or mentioned                   |
 * | `always`       | always                                           |
 *
 * @param mode - The member's per-room response mode.
 * @param opts.roomKind - The room's kind.
 * @param opts.mentioned - Whether this member is in the entry's resolved mentions.
 */
export function respondsTo(
  mode: ResponseMode,
  opts: { roomKind: RoomKind; mentioned: boolean }
): boolean {
  switch (mode) {
    case 'silent':
      return false;
    case 'mention-only':
      return opts.mentioned;
    case 'direct-only':
      return opts.roomKind === 'dm' || opts.mentioned;
    case 'always':
      return true;
  }
}

/**
 * The agent members a committed post should trigger, in roster order.
 *
 * The entry's own author is never a target — an agent does not answer itself,
 * and `always` in a two-agent room would otherwise be an immediate loop.
 *
 * @param opts.roomKind - The room's kind; `direct-only` reads it.
 * @param opts.entry - The committed entry.
 * @param opts.members - The room's roster.
 * @returns Author ids to trigger, before the cascade guard has its say.
 */
export function selectTriggerTargets(opts: {
  roomKind: RoomKind;
  entry: AddressingEntry;
  members: readonly AddressingMember[];
}): string[] {
  const mentioned = new Set(opts.entry.mentions);
  return opts.members
    .filter((member) => member.kind === 'agent' && member.authorId !== opts.entry.authorId)
    .filter((member) =>
      respondsTo(member.responseMode, {
        roomKind: opts.roomKind,
        mentioned: mentioned.has(member.authorId),
      })
    )
    .map((member) => member.authorId);
}
