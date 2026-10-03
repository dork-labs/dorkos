/** One private core, replay lifetime and frame facade; no duplicated issuer. */
import type { Dispatch, SetStateAction } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import type { DocChannelView } from './doc-channel-view';
import {
  createOwnedCustody,
  startOwnedCustody,
  disposeOwnedCustody,
} from './doc-channel-owner-custody';
import { createOwnedReplayLifetime, createOwnedReplayRun } from './doc-channel-owner-replay';
import { createOwnedFrameFacade } from './doc-channel-owner-frame';

/** Compose the private record, replay and frame operations for the captured document Transport. */
export function createDocChannelOwner(
  documentId: string,
  transport: Transport,
  dispatch: Dispatch<SetStateAction<DocChannelView>>
) {
  const owner = createOwnedCustody(documentId, transport, dispatch);
  createOwnedReplayLifetime(owner);
  const frameAdmission = createOwnedFrameFacade(owner);
  return Object.freeze({
    beginRun: () => createOwnedReplayRun(owner),
    frameAdmission,
    start: (recover: () => void) => startOwnedCustody(owner, recover),
    dispose: () => disposeOwnedCustody(owner),
  });
}
