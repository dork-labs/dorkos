import type { Db, DbTransaction, SQL } from '@dorkos/db';
import type { RoomEntry, RoomKind } from '@dorkos/shared/room-schemas';
import type { GrantedDocTargetBindingReader } from '../service/room-service-deps.js';
import type { RoomSessionLedger } from '../session-bindings/room-session-ledger.js';
import type { RoomStore, TopLevelWindow } from '../room-store.js';

/** Fixed live original Room store ports; copied structures cannot establish private membership. */
export interface OriginalRoomStoreMethodView {
  readonly originalStore: RoomStore;
  readonly afterTimelineEntry: (roomId: string, afterSeq: number) => SQL;
  readonly beforeTimelineEntry: (roomId: string, beforeSeq: number) => SQL;
  readonly db: Db;
  readonly docTargetBindingReader: GrantedDocTargetBindingReader;
  readonly getMember: RoomStore['getMember'];
  readonly getRoom: RoomStore['getRoom'];
  readonly getRoomSession: RoomStore['getRoomSession'];
  readonly inOneTransaction: (
    tx: DbTransaction | undefined,
    writes: (exec: Db | DbTransaction) => void
  ) => void;
  readonly maxSeq: RoomStore['maxSeq'];
  readonly recentPostsInScope: (
    roomId: string,
    opts: { threadRootEntryId: string | null; excludeAuthorId: string | null; limit: number }
  ) => RoomEntry[];
  readonly sessionLedger: RoomSessionLedger;
  readonly syncDmMemberKey: (roomId: string, exec: Db | DbTransaction) => void;
  readonly timelineOrder: (roomId: string, direction: 'asc' | 'desc') => SQL[];
  readonly timelineScope: (roomId: string, thread?: string | null) => SQL | undefined;
  readonly dmMemberKeyFor: (
    kind: RoomKind,
    bridged: boolean,
    members: ReadonlyArray<{ authorId: string }>
  ) => string | null;
  readonly topLevelWindow: (roomId: string, opts: TopLevelWindow) => SQL | undefined;
}
