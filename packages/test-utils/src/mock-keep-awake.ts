/**
 * The keep-awake status a fresh install reports while nothing is running, for
 * mock transports and tests that only need a valid status to render.
 *
 * @module test-utils/mock-keep-awake
 */
import type { KeepAwakeStatus } from '@dorkos/shared/schemas';

/** Mode `agents`, no work, no timed session, nothing held, nothing blocked. */
export const IDLE_KEEP_AWAKE_STATUS: KeepAwakeStatus = {
  enabled: true,
  mode: 'agents',
  manual: null,
  level: null,
  blocked: null,
  supported: true,
  reason: null,
  asserted: false,
  working: { chats: 0, rooms: 0, tasks: 0, waking: false },
  wake: { enabled: false, setup: 'unsupported', nextWakeAt: null, setupCommand: null },
};
