/** Single-flight replay composition. Authority lives only in the private owner controller. */
import type { Dispatch, SetStateAction } from 'react';
import type { Transport } from '@dorkos/shared/transport';
import { createDocChannelOwner } from './doc-channel-owner';
import { createDocReplayTask } from './doc-channel-replay-task';
import type { DocChannelView } from './doc-channel-view';
/** Expose the closed recovery controller while keeping record issuance and currentness private. */
export function createDocChannelRecovery(
  documentId: string,
  transport: Transport,
  dispatch: Dispatch<SetStateAction<DocChannelView>>
) {
  const owner = createDocChannelOwner(documentId, transport, dispatch);
  const task = createDocReplayTask(() => {
    const run = owner.beginRun();
    return {
      async page(): Promise<'again' | 'done'> {
        const ticket = await run.readPage();
        if (!ticket) return 'done';
        const result = run.consumePage(ticket);
        if (result.kind !== 'frames') return result.kind;
        for (let index = 0; index < result.count; index++) {
          if (!run.advancePageFrame(ticket, index)) return 'done';
        }
        return run.finishPage(ticket);
      },
      failed: () => run.failed(),
      beginFinalization: () => {
        const instruction = run.beginFinalization();
        if (instruction !== 'drain') run.end();
        return instruction;
      },
      drainOne(): 'again' | 'tail' | 'restart' | 'stop' {
        if (!run.current()) {
          run.end();
          return 'stop';
        }
        const ticket = run.takePending();
        if (!ticket) return 'tail';
        if (run.advancePending(ticket)) return 'again';
        run.end();
        return 'stop';
      },
      finishFinalization: () => {
        try {
          return run.finishFinalization();
        } finally {
          run.end();
        }
      },
    };
  });
  owner.start(() => {
    void task.request().catch(() => {});
  });
  return Object.freeze({ dispose: owner.dispose });
}
