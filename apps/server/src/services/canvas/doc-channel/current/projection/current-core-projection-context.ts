import type { createPrivateCurrentEngineState } from '../current-private-state.js';
import type { createPrivateEngineDelegateCalls } from '../current-private-delegate-calls.js';

/** Original constructor-private state and bound scheduling ports; no structural fallback is accepted. */
export interface OriginalEngineCoreProjectionFacet {
  readonly state: ReturnType<typeof createPrivateCurrentEngineState>;
  readonly delegates: ReturnType<typeof createPrivateEngineDelegateCalls>;
  readonly queuePresence: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly trackTokenOperation: <T>(operation: () => Promise<T>) => Promise<T>;
  readonly stopRoomPump: () => Promise<void>;
}
