import { registerHeldProcessTests } from './chat/held-process.js';
import { registerLiveTurnVisibilityTests } from './chat/live-turn-visibility.js';
import { MOCK_API_URL, useMockServer } from './chat/mock-server.js';
import { registerRuntimeCapabilityParityTests } from './chat/runtime-capability-parity.js';

/**
 * Live turns, warm agents and runtime parity, against the test-mode server. One
 * of the `chat-mock*.spec.ts` files: they share the server and its resets, and
 * the `chromium-mock` project runs them one at a time on one worker
 * (`tests/chat/mock-server.ts`).
 */

const agentDir = useMockServer();

// What a live turn shows while it runs, and how Stop settles it (capability rows
// C-10, R-05, R-06, R-07, DOR-1214). These hold a turn open across several
// assertions using step barriers, which only survives with no concurrent reset.
registerLiveTurnVisibilityTests({ apiUrl: MOCK_API_URL, agentDir });

// The persistent path — warm agents, a steer that cuts in, Add context, and Stop
// on a warm agent (L-11, C-09b, C-11, C-10's pump scope; DOR-1326). Same lock as
// the suite above, plus one of its own: it puts individual sessions on the
// held-process path, which only stays contained because these tests run one at
// a time on one worker.
registerHeldProcessTests({ apiUrl: MOCK_API_URL, agentDir });

// The app adapting to the runtime it is talking to (L-10). This leg is the ONLY
// place a browser can see a runtime that is not Claude Code: real Codex and
// OpenCode need model credentials a PR runner does not have, so the divergent
// descriptors TestModeRuntime declares are the whole available surface. See the
// module header for what that does and does not cover.
registerRuntimeCapabilityParityTests({ agentDir });
