import {
  RELAY_DISPATCH_OK,
  type RelayDispatchVerdict,
} from '../../relay/task-dispatch/readiness.js';

/**
 * What a caller that wired a relay but never said which runtimes it holds means:
 * the v1 answer, claude-code and nothing else.
 *
 * The same compat reading `normalizeAgentRuntimes` gives a bare runtime that
 * declares no `type`, and for the same reason — it is what such a caller has
 * always meant, so honouring it keeps every existing relay caller routing
 * exactly as it did. Defaulting to "holds nothing" was measured instead: it sent
 * every relay test's run down the direct path, which is safe but silently makes
 * those tests stop testing the bus.
 *
 * Production never takes this default; `index.ts` passes
 * `AdapterManager.canRunTaskOnBus`, which is the only answer that reads live
 * adapter state.
 */
export const V1_RELAY_RUNTIME = (runtimeType: string): RelayDispatchVerdict =>
  runtimeType === 'claude-code'
    ? RELAY_DISPATCH_OK
    : { deliverable: false, reason: 'runtime-not-on-bus' };
