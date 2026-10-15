import type { RoomWorktreeManager } from '../room-worktree-manager.js';

/** Fixed private native manager and original retirement DATA; never caller-supplied authority. */
export interface RoomWorktreeRetirementView {
  readonly originalManager: RoomWorktreeManager;
  readonly retired: Set<string>;
  readonly LEGACY_PARENT_DIRS: readonly string[];
  readonly LEGACY_ATTACHMENTS_DIR: string;
  readonly EXCLUDE_SENTINEL: string;
  readonly EXCLUDE_END: string;
}
