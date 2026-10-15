/** Original repo service DATA contracts, with no runtime state or effect entry points. */
import type { Room } from '@dorkos/shared/room-schemas';
import type { RoomRepoCaps, RoomRepoSidecar } from '@dorkos/shared/room-repo';
import type { RoomRepoStore } from '../room-repo-store.js';
import type { RoomRepoMutex } from '../room-repo-mutex.js';
import type { Db } from '@dorkos/db';
import type { RoomStore } from '../../room-store.js';
import type { RoomService } from '../../room-service.js';
import type { InstallationFileWrites } from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import type { DocChannelStore } from '../../../canvas/doc-channel/store.js';
import type { InstallationRoomWrites } from '../../../canvas/doc-channel/writes/installation-room-writes.js';

/** What the operator asked to do about changes DorkOS did not make. */
export type RoomMainRepair =
  | { action: 'commit' }
  | {
      action: 'discard';
      /**
       * Exactly which files to throw away. Never empty, and every one of them
       * must be a path the room is currently reporting as changed.
       */
      paths: string[];
    };

/** Exact original private repair outcome shared by root-owned repair operations. */
export interface RepairAction {
  /** Which action ran. */
  action: RoomMainRepair['action'];
  /** The commit that kept the changes, or `null` for a discard. */
  commit: string | null;
  /** How many paths it dealt with. */
  paths: number;
}

/** What a repair did. */
export interface RoomMainRepairResult extends RepairAction {
  /**
   * Whether the room's files are clean now.
   *
   * `false` after a discard that named some of the stray changes and not
   * others, which is a legitimate thing to do — and the answer says so rather
   * than letting a client assume merges have resumed.
   */
  clean: boolean;
}

/** What {@link RoomRepoService.enable} answers. */
export interface EnableRoomRepoResult {
  /** `false` when the room already had files and nothing was changed. */
  created: boolean;
  /** The binding — the one just made, or the one that was already there. */
  repo: RoomRepoSidecar;
}

/** The seams {@link RoomRepoService} needs from the rest of the server. */
export interface RoomRepoServiceDeps {
  /** File-first store for the sidecar and its cache row. */
  store: RoomRepoStore;
  /**
   * The per-room serialized queue every server-side write to a room's repo goes
   * through — **the same instance the merge verb uses** (`room-repo-mutex.ts`).
   *
   * Required rather than optional, because what it protects is a check-then-act
   * with an `await` in the middle: see {@link RoomRepoService.enable}. A wiring
   * that forgot it would compile, pass every single-caller test, and lose a
   * room's first commit the first time two callers arrived together.
   */
  mutex: RoomRepoMutex;
  /**
   * How long a caller may wait for the room's queue, in milliseconds
   * (`config.rooms.repo.mergeQueueWaitMs`). Read per call.
   */
  queueWaitMs: () => number;
  /**
   * Whether rooms may have files at all (`config.rooms.repo.enabled`).
   *
   * Read per call, not captured: switching the feature back on has to bind the
   * very next request, not the next server start — the same rule every other
   * live config reader in the rooms domain follows.
   */
  enabled: () => boolean;
  /**
   * The room as this caller can see it, or `null` when they cannot see it at
   * all. `RoomService.getRoom` in production.
   */
  getRoom: (roomId: string, viewerAuthorId: string) => Room | null;
  /** Whether an author is the person who owns this install. */
  isOwnerAuthor: (authorId: string) => boolean;
  /**
   * The name operator commits are authored under, or `null` when this install
   * has no name for them yet.
   */
  operatorGitName: () => string | null;
  /**
   * The caps a NEW binding is created under, seeded from config.
   *
   * Read once at create and then stored on the sidecar, so a later config
   * change cannot retroactively make an existing repo's contents illegal.
   */
  caps: () => RoomRepoCaps;
  /**
   * Put this room's brand-new `ROOM.md` on its canvas, pinned.
   *
   * Called once, after the seed commit, for the room that just got files — which
   * is the one moment a `ROOM.md` starts existing. The notes everybody in the
   * room shares are the one document that is worth a tab by default, and pinning
   * it is what stops a busy room's twelve-document ceiling ever pushing it off.
   *
   * Required rather than optional, for the reason
   * {@link RoomRepoServiceDeps.mutex} is: a wiring that forgot it would compile,
   * pass every test in this file, and quietly give every new room's shared notes
   * no place to be.
   *
   * It must not throw — it is called inside the repo's own queue, and a canvas
   * that refused would unwind a repo that was successfully created.
   */
  pinRoomMd: (roomId: string, authorId: string) => void;
  /**
   * How many bytes of `ROOM.md` may ride a member agent's turn, read LIVE from
   * `config.rooms.repo.maxRoomMdBytes`.
   *
   * Beside {@link RoomRepoServiceDeps.caps} rather than inside it, because the
   * two answer different questions and must be free to disagree. `caps` is
   * frozen onto a room's sidecar at create so a config change cannot make an
   * existing repo's CONTENTS illegal. This one bounds what is SENT, which is a
   * cost paid on every message — somebody who turns it down means the next turn.
   */
  maxRoomMdBytes: () => number;
}

/** Exact original installation-owned repo construction identities. */
export interface RoomRepoOwningConstruction {
  readonly owner: InstallationFileWrites;
  readonly writer: InstallationRoomWrites;
  readonly db: Db;
  readonly channels: DocChannelStore;
  readonly rooms: RoomService;
  readonly roomStore: RoomStore;
}
