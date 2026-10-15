/** Real protected-source fixture composition. No browser/page can select an actor or issuer. */

import { requireOriginalConsumerControls } from '../channel-store.js';
/** Original fixed reviewed controls; no supplied mutable context or original-key issuer. */
export function createOriginalConsumerReviewedControls(ownerKey: object) {
  const context = requireOriginalConsumerControls(ownerKey);
  const {
    vault,
    hostBootstrap,
    target,
    db,
    agentId,
    sessionId,
    rooms,
    http,
    actor,
    queue,
    admission,
    runtime,
    runtimeRegistry,
  } = context;
  return {
    /** Fixed new source; its original route decision is made in the actual operator UI. */
    openReviewedReplayFile() {
      if (
        !hostBootstrap ||
        target !== 'session' ||
        context.closed ||
        !admission ||
        context.reviewedSetupWork
      )
        throw new Error('Original reviewed replay setup unavailable');
      context.reviewedSetupWork = (async () => {
        const { createOriginalReviewedReplayControl } =
          await import('../native-reviewed-replay-control.js');
        if (context.closed) throw new Error('Original reviewed replay setup retired');
        context.reviewedControl = createOriginalReviewedReplayControl({
          db,
          http,
          rooms,
          actor,
          root: vault.root,
          scope: context.scope,
          sessionId,
          agentId,
          admission,
          queue,
          runtime,
          runtimes: runtimeRegistry,
        });
        return context.reviewedControl.open();
      })();
      return context.reviewedSetupWork;
    },
    expireOriginalReviewedReplay() {
      if (context.closed || !context.reviewedControl)
        throw new Error('Original reviewed replay source unavailable');
      context.pumpInstalled = true; // Own any genuine nudge/dispatcher installation, including an unexpected admission.
      return context.reviewedControl.expire();
    },
    pumpOriginalReviewedReplay() {
      if (context.closed || !context.reviewedControl)
        throw new Error('Original reviewed replay source unavailable');
      context.pumpInstalled = true;
      return context.reviewedControl.pump();
    },
    readOriginalReviewedReplayData() {
      if (context.closed || !context.reviewedControl)
        throw new Error('Original reviewed replay source unavailable');
      return context.reviewedControl.read();
    },
    stopOriginalReviewedReplay() {
      return context.reviewedControl?.stop();
    },
  };
}
