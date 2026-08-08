/**
 * Recents entity — the unified "Jump back in" model (spec `team-room-home`
 * §D2.3): one ordered list of the threads a person was last in, whatever kind
 * of thread each one is.
 *
 * It is an entity rather than a feature because two surfaces read it — the
 * sidebar section and the home composer's popover — and neither owns it.
 *
 * @module entities/recents
 */
export { useJumpBackIn } from './model/use-jump-back-in';
export type { UseJumpBackIn, UseJumpBackInOptions } from './model/use-jump-back-in';
export { mergeJumpBackIn, MAX_JUMP_BACK_IN } from './lib/jump-back-in';
export type {
  JumpBackInItem,
  JumpBackInKind,
  JumpBackInModel,
  JumpBackInRoomItem,
  JumpBackInSessionItem,
  MergeJumpBackInInput,
} from './lib/jump-back-in';
