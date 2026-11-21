/**
 * Runtime capability rows for the DorkOS features that call into agent runtimes.
 *
 * @module test-utils/runtime-capability-product
 */
import type { MatrixCell, RuntimeCapability } from './runtime-capability-types.js';

const ROOM_CONTEXT =
  'apps/server/src/services/runtimes/shared/__tests__/room-context-runtime-neutrality.test.ts';
const ROOM_REPLIES = 'apps/e2e/tests/rooms/room-tool-only-replies.spec.ts';
const TASK_RUN = 'apps/server/src/services/tasks/__tests__/task-scheduler-service.test.ts';
const RELAY_DELIVERY =
  'apps/server/src/services/relay/__tests__/agent-subject-target-runtime.integration.test.ts';
const EXTENSION_LIST =
  'apps/server/src/services/runtimes/claude-code/mcp-tools/__tests__/extension-tool-listing.test.ts';
const KEEP_AWAKE = 'apps/server/src/services/core/keep-awake/__tests__/hold-during-turn.test.ts';
const CODEX_KEEP_AWAKE =
  'apps/server/src/services/runtimes/codex/__tests__/codex-keep-awake.test.ts';

function tested(tier: 'U' | 'E', file: string, ...titles: string[]): MatrixCell {
  return {
    status: 'supported',
    evidence: [tier],
    references: titles.map((title) => ({ tier, file, title })),
  };
}

function unverified(reason: string): MatrixCell {
  return { status: 'unverified', reason };
}

const ROOM_REPLY_UNVERIFIED = unverified('The browser cases drive scripted test-mode replies.');
const NAMED_TASK_UNVERIFIED = unverified('The scheduler cases use Codex as the named runtime.');
const RELAY_TARGET_UNVERIFIED = unverified(
  'The target-manifest delivery cases register Claude Code and Codex.'
);
const EXTENSION_LIST_UNVERIFIED = unverified(
  'The extension tool-listing case exercises the Claude Code transport.'
);

// All five runtimes enter the same registry decorator before a streamed turn.
const SHARED_CHAT_HOLD = tested(
  'U',
  KEEP_AWAKE,
  'holds a turn on any runtime resolved from runtimeRegistry, exactly once'
);
const SHARED_SLEEP_ONLY: MatrixCell = {
  status: 'n/a',
  reason: 'DorkOS uses the shared hold for this runtime.',
};

/** Product rows with the exact test cases that exercise their claimed behavior. */
export const PRODUCT_RUNTIME_CAPABILITIES: readonly RuntimeCapability[] = [
  {
    id: 'RT-ROOM-01',
    group: 'ROOM',
    title: 'Carry room messages as context',
    expected: 'A room turn receives member messages inside a labeled room context block.',
    cells: {
      'claude-code': tested('U', ROOM_CONTEXT, 'carries room context for Claude Code'),
      codex: tested('U', ROOM_CONTEXT, 'carries room context for Codex'),
      opencode: tested('U', ROOM_CONTEXT, 'carries room context for OpenCode'),
      doe: {
        status: 'partial',
        reason:
          'The formatter case checks the room block and its label, leaving message text unchecked.',
        evidence: ['U'],
        references: [
          {
            tier: 'U',
            file: 'apps/server/src/services/runtimes/doe/__tests__/context.test.ts',
            title: 'carries neutral $kind context through its shared formatter',
          },
        ],
      },
      'test-mode': unverified('The browser room cases check delivery after the scripted turn.'),
    },
  },
  {
    id: 'RT-ROOM-02',
    group: 'ROOM',
    title: 'Post one reply to the room',
    expected:
      'A reply posted through the room capability appears once, and a quiet turn nobody asked for leaves the room unchanged.',
    cells: {
      'claude-code': ROOM_REPLY_UNVERIFIED,
      codex: ROOM_REPLY_UNVERIFIED,
      opencode: ROOM_REPLY_UNVERIFIED,
      doe: ROOM_REPLY_UNVERIFIED,
      'test-mode': tested(
        'E',
        ROOM_REPLIES,
        'a tool-only reply lands once, and its own narration never reaches the room',
        'nobody asked, so a quiet turn leaves the room unchanged and the pill clears'
      ),
    },
  },
  {
    id: 'RT-TASK-01',
    group: 'TASK',
    title: 'Run a task on its chosen runtime',
    expected:
      'A scheduled run uses its named runtime and records a failure without starting a turn elsewhere when that runtime is disabled.',
    cells: {
      'claude-code': NAMED_TASK_UNVERIFIED,
      codex: tested(
        'U',
        TASK_RUN,
        'runs the task on the runtime IT names, not the registry default',
        'fails the run loudly when the named runtime is not turned on, and starts no turn'
      ),
      opencode: NAMED_TASK_UNVERIFIED,
      doe: NAMED_TASK_UNVERIFIED,
      'test-mode': NAMED_TASK_UNVERIFIED,
    },
  },
  {
    id: 'RT-RELAY-01',
    group: 'RELAY',
    title: 'Deliver to the target agent’s runtime',
    expected:
      'An agent message reaches the registered runtime named by the target’s manifest and starts one turn there.',
    cells: {
      'claude-code': tested('U', RELAY_DELIVERY, 'answers a claude-code agent on claude-code'),
      codex: tested(
        'U',
        RELAY_DELIVERY,
        'answers a codex agent on codex, not on the default runtime'
      ),
      opencode: RELAY_TARGET_UNVERIFIED,
      doe: RELAY_TARGET_UNVERIFIED,
      'test-mode': RELAY_TARGET_UNVERIFIED,
    },
  },
  {
    id: 'RT-EXT-01',
    group: 'EXT',
    title: 'List accepted extension tools',
    expected:
      'The session tool list includes accepted extension tools alongside built-in tools and drops extension tools when unregistered.',
    cells: {
      'claude-code': tested(
        'U',
        EXTENSION_LIST,
        'lists every core tool and the accepted extension tools, and never the refused one'
      ),
      codex: EXTENSION_LIST_UNVERIFIED,
      opencode: EXTENSION_LIST_UNVERIFIED,
      doe: EXTENSION_LIST_UNVERIFIED,
      'test-mode': EXTENSION_LIST_UNVERIFIED,
    },
  },
  {
    id: 'RT-AWAKE-01',
    group: 'AWAKE',
    title: 'Hold keep-awake during an active chat turn',
    expected:
      'A streamed chat turn through the runtime registry adds one hold to the shared keep-awake counter and releases it when the turn ends.',
    cells: {
      'claude-code': SHARED_CHAT_HOLD,
      codex: SHARED_CHAT_HOLD,
      opencode: SHARED_CHAT_HOLD,
      doe: SHARED_CHAT_HOLD,
      'test-mode': SHARED_CHAT_HOLD,
    },
  },
  {
    id: 'RT-AWAKE-02',
    group: 'AWAKE',
    title: 'Apply keep-awake in the runtime’s own process',
    expected:
      'The runtime receives the idle sleep setting when keep-awake applies and reloads the session before its next turn after the setting changes.',
    cells: {
      'claude-code': SHARED_SLEEP_ONLY,
      codex: tested(
        'U',
        CODEX_KEEP_AWAKE,
        'loads the thread with features.prevent_idle_sleep while keep-awake applies',
        'leaves it out while keep-awake does not apply',
        'reloads the thread before its next turn when the keep-awake setting changes'
      ),
      opencode: SHARED_SLEEP_ONLY,
      doe: SHARED_SLEEP_ONLY,
      'test-mode': SHARED_SLEEP_ONLY,
    },
  },
];
