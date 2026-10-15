import type { Db, DbTransaction } from '@dorkos/db';
import type { DocChannelService } from '../../service.js';
import type { DocChannelStore } from '../../store.js';
import type { DocChannelGrants } from '../../grants.js';
import type {
  OriginalRoomOperatorProducer,
  OriginalRoomTokenProducer,
} from '../current-operation-types.js';
import type { OriginalCurrentEntryFacet } from '../projection/current-entry-context.js';
import type { OriginalTokenNativeInputFacet } from '../token/current-token-native-input-context.js';
/** Original native operator/token source readers with private engine membership. */
export interface OriginalRoomProducerFacet extends OriginalTokenNativeInputFacet {
  readonly nativePrepare: Db['$client']['prepare'];
  readonly tokenSourceDependencies:
    { service: DocChannelService; store: DocChannelStore; grants: DocChannelGrants } | undefined;
  readonly fixedCurrent: OriginalCurrentEntryFacet['fixedCurrent'];
  readonly operatorRows: (
    documentId: string,
    roomId: string,
    key: string,
    tx?: DbTransaction
  ) => Record<string, unknown> | undefined;
  readonly requireOperatorRows: (
    producer: OriginalRoomOperatorProducer | OriginalRoomTokenProducer,
    tx?: DbTransaction
  ) => void;
}
