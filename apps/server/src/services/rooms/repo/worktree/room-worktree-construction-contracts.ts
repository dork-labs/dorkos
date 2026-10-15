import type { Stats } from 'node:fs';
import type {
  RoomWorktreeManager,
  RoomWorktreeOwningConstruction,
} from '../room-worktree-manager.js';
import type { RoomWorktreeManagerDeps } from './room-worktree-contracts.js';

/** Fixed root-private construction facts and helper receivers; never caller-minted effect ports. */
export interface RoomWorktreeConstructionView {
  readonly originalManager: RoomWorktreeManager;
  readonly deps: Readonly<RoomWorktreeManagerDeps>;
  readonly owning: RoomWorktreeOwningConstruction | undefined;
  readonly retired: Set<string>;
  readonly nowMs: () => number;
  readonly sameWorktreeInode: (left: Stats, right: Stats) => boolean;
  readonly directoryExists: (dir: string) => Promise<boolean>;
  readonly isCheckout: (dir: string) => Promise<boolean>;
}
