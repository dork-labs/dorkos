import type { TestModeNativeEntry } from './test-mode-native-types.js';
import { requireNativePrincipalDatabase } from '../../../connectors/principal/runtime-principal-service.js';
import { readOriginalTestModeNativeAcquisitionView } from '../test-mode-runtime.js';
import { readOriginalRoomLaunchHolder } from '../../../session/trigger-turn.js';
import { readOriginalRegisteredRuntime } from '../../../core/runtime-registry.js';
import {
  captureNativeSessionAcquisition,
  isOriginalNativeSessionAcquisitionAlias,
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  isNativeSessionAcquisitionMove,
} from '../../../session/session-lock.js';
import type { Db } from '@dorkos/db';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { RoomTurnRequest } from '../../../rooms/room-turn-port.js';
import type { OriginalTestModeCanonicalRestart } from './test-mode-native-types.js';

/** Read the original native launch alias through its constructor-private fixed view. */
export function readOriginalTestModeNativeLaunchAlias(
  ownerKey: object,
  request: RoomTurnRequest,
  retiredId: string
): boolean {
  const facet = readOriginalTestModeNativeAcquisitionView(ownerKey);
  const { originalMapGet } = facet;
  const launch = readOriginalRoomLaunchHolder(request);
  const canonical = originalMapGet.call(facet.aliases, retiredId) as string | undefined;
  if (
    !launch ||
    (readOriginalRegisteredRuntime(launch.runtime) ?? launch.runtime) !== facet.runtime ||
    canonical !== launch.key
  )
    return false;
  const acquisition = captureNativeSessionAcquisition(facet.locks, launch.key, launch.holder);
  return (
    !!acquisition &&
    isOriginalNativeSessionAcquisitionAlias(
      facet.locks,
      acquisition,
      launch.holder,
      launch.key,
      retiredId
    ) &&
    readOriginalRoomLaunchHolder(request) === launch &&
    originalMapGet.call(facet.aliases, retiredId) === canonical
  );
}

/** Capture the original canonical restart through its constructor-private fixed view. */
export function captureOriginalTestModeNativeRestart(
  ownerKey: object,
  sessionId: string,
  db: Db
): OriginalTestModeCanonicalRestart {
  const facet = readOriginalTestModeNativeAcquisitionView(ownerKey);
  const { originalMapGet, nativeSignalAborted, originalCanonicalRestarts } = facet;
  if (!facet.principals) throw new Error('Original canonical principal assembly required');
  requireNativePrincipalDatabase(facet.principals, db);
  const entry = originalMapGet.call(facet.entries, sessionId) as TestModeNativeEntry | undefined;
  if (
    !entry ||
    entry.retired ||
    entry.roomOrigin ||
    !entry.canonicalScenarioStarted ||
    entry.scenarioStarts !== 1 ||
    nativeSignalAborted.call(entry.controller.signal)
  )
    throw new Error('Original held interactive canonical producer required');
  const time = Date.now(),
    activity = captureNativeSessionActivity(entry.acquisition, time);
  if (
    !activity ||
    !readNativeSessionAcquisition(entry.acquisition, activity, time, entry.canonicalSessionId)
  )
    throw new Error('Original held canonical acquisition required');
  const token: OriginalTestModeCanonicalRestart = Object.freeze({
    kind: 'original-testmode-canonical-restart',
  });
  originalCanonicalRestarts.set(token, {
    runtime: facet.runtime,
    db,
    entry,
    locks: facet.locks,
  });
  return token;
}

/** Move the original held acquisition through its constructor-private fixed view. */
export function moveOriginalTestModeNativeAcquisition(
  ownerKey: object,
  oldKey: string,
  canonicalKey: string,
  holder: SseResponse
): boolean {
  const facet = readOriginalTestModeNativeAcquisitionView(ownerKey);
  const { originalMapGet, originalMapSet, originalMapEntries, nativeSignalAborted } = facet;
  const entry = originalMapGet.call(facet.entries, oldKey) as TestModeNativeEntry | undefined;
  if (
    !entry ||
    entry.retired ||
    entry.canonicalSessionId !== canonicalKey ||
    nativeSignalAborted.call(entry.controller.signal)
  )
    return false;
  const time = Date.now(),
    activity = captureNativeSessionActivity(entry.acquisition, time);
  if (!activity || !readNativeSessionAcquisition(entry.acquisition, activity, time, oldKey))
    return false;
  const next = captureNativeSessionAcquisition(facet.locks, canonicalKey, holder);
  if (!next || !isNativeSessionAcquisitionMove(entry.acquisition, next, holder)) return false;
  entry.acquisition = next;
  // Historical alias DATA comes only from this actual native acquisition move.
  // Public declared test renames cannot certify a constructor-native launch.
  for (const [id, current] of originalMapEntries.call(facet.aliases))
    if (current === oldKey) originalMapSet.call(facet.aliases, id, canonicalKey);
  originalMapSet.call(facet.aliases, oldKey, canonicalKey);
  return true;
}
