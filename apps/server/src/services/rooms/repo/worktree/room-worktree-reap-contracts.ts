import type {
  RoomWorktreeManager,
  RoomWorktreeOwningConstruction,
} from '../room-worktree-manager.js';
import type { RoomRepoStore } from '../room-repo-store.js';

/** Exact original private Worktree reap state, available only after root-owned key membership. */
export interface RoomWorktreeReapView {
  readonly originalManager: RoomWorktreeManager;
  readonly owning: RoomWorktreeOwningConstruction | undefined;
  readonly originalManagers: Readonly<
    Pick<WeakMap<RoomWorktreeManager, { store: RoomRepoStore }>, 'get'>
  >;
  readonly reapContexts: WeakSet<object>;
  readonly reapEffects: WeakMap<object, () => void>;
  readonly slugDigestChars: number;
  readonly nowMs: () => number;
}
