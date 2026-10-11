import type { Db } from '@dorkos/db';
import type { RoomService } from '../room-service.js';
import type { RoomStore } from '../room-store.js';
import {
  readRoomCoreRepoAgentRoster,
  requireRoomCoreFileWriteStore,
  readRoomCoreOriginalBusyAgents,
  readRoomCoreOriginalFileRequest,
  type RoomCore,
} from './room-core.js';
import {
  requireRoomVisibilityRepoWriteCurrent,
  requireRoomVisibilityFileWriteCurrent,
  type RoomVisibility,
} from './room-visibility.js';

/** Each factory owns unrelated service custody; the actual registrar stays private to original RoomService. */
export function createIsolatedRoomServiceFilePolicyCustody() {
  const filePolicyServices = new WeakMap<
    RoomService,
    { core: RoomCore; visibility: RoomVisibility }
  >();
  /** Original constructor-bound busy DATA protects live turns; it grants no cleanup permission. */
  function readRoomServiceOriginalBusyAgents(
    service: RoomService,
    db: Db,
    store: RoomStore
  ): readonly string[] {
    const binding = filePolicyServices.get(service);
    if (!binding) throw new Error('Unknown original room busy service.');
    const result = readRoomCoreOriginalBusyAgents(binding.core, db, store);
    if (filePolicyServices.get(service) !== binding) throw new Error('Room busy service changed.');
    return result;
  }
  /** Actual service/core/store/native construction; actual HTTP composition additionally pins its exact service. */
  function requireRoomServiceFileWriteOwner(
    service: RoomService,
    exactDb: Db,
    exactStore: RoomStore
  ): undefined {
    const binding = filePolicyServices.get(service);
    if (!binding) throw new Error('Unknown original room file service.');
    requireRoomCoreFileWriteStore(binding.core, exactDb, exactStore);
    return undefined;
  }
  /** Require current file-write visibility through the original Room service. */
  function requireRoomServiceFileWriteCurrent(
    service: RoomService,
    exactDb: Db,
    roomId: string,
    authorId: string
  ): undefined {
    const binding = filePolicyServices.get(service);
    if (!binding) throw new Error('Unknown original room file service.');
    requireRoomVisibilityFileWriteCurrent(binding.visibility, exactDb, roomId, authorId);
    if (filePolicyServices.get(service) !== binding)
      throw new Error('Original room file service changed.');
    requireRoomCoreFileWriteStore(binding.core, exactDb);
    return undefined;
  }

  /** No public actor, visibility callback or DTO can select this native policy. */
  function requireRoomServiceRepoWriteCurrent(
    service: RoomService,
    exactDb: Db,
    roomId: string,
    authorId: string,
    operation: 'enable' | 'repair' | 'merge'
  ): undefined {
    const binding = filePolicyServices.get(service);
    if (!binding) throw new Error('Unknown original room repo service.');
    requireRoomVisibilityRepoWriteCurrent(binding.visibility, exactDb, roomId, authorId, operation);
    if (filePolicyServices.get(service) !== binding)
      throw new Error('Original room repo service changed.');
    requireRoomCoreFileWriteStore(binding.core, exactDb);
    return undefined;
  }

  /** Constructor-owned ordinary Room request policy; Doc cascade eligibility remains separate. */
  function readRoomServiceOriginalFileRequest(
    service: RoomService,
    db: Db,
    store: RoomStore,
    request: import('../room-turn-port.js').RoomTurnRequest,
    runner: import('../room-turn-port.js').RoomTurnRunner
  ) {
    const binding = filePolicyServices.get(service);
    if (!binding) return undefined;
    const facts = readRoomCoreOriginalFileRequest(binding.core, db, store, request, runner);
    if (!facts || filePolicyServices.get(service) !== binding) return undefined;
    requireRoomCoreFileWriteStore(binding.core, db, store);
    return facts;
  }
  /** Fixed captured roster reader; a data row does not replace original member/owner/native caller checks. */
  function readRoomServiceRepoAgentRoster(service: RoomService, exactDb: Db, roomId: string) {
    const binding = filePolicyServices.get(service);
    if (!binding) throw new Error('Unknown original room repo service.');
    const rows = readRoomCoreRepoAgentRoster(binding.core, exactDb, roomId);
    if (filePolicyServices.get(service) !== binding)
      throw new Error('Original room repo service changed.');
    requireRoomCoreFileWriteStore(binding.core, exactDb);
    return rows;
  }

  function register(
    service: RoomService,
    binding: Readonly<{ core: RoomCore; visibility: RoomVisibility }>
  ): void {
    filePolicyServices.set(service, binding);
  }
  return Object.freeze({
    register,
    readRoomServiceOriginalBusyAgents,
    requireRoomServiceFileWriteOwner,
    requireRoomServiceFileWriteCurrent,
    requireRoomServiceRepoWriteCurrent,
    readRoomServiceOriginalFileRequest,
    readRoomServiceRepoAgentRoster,
  });
}
