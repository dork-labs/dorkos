import { registerInteractivePromptTests } from './chat/interactive-prompts.js';
import { MOCK_API_URL, useMockServer } from './chat/mock-server.js';
import { registerAskAnywhereTests } from './conversation/ask-anywhere.js';
import { registerAskParksTests } from './conversation/ask-parks.js';

/**
 * Prompts a turn stops on, against the test-mode server. One of the
 * `chat-mock*.spec.ts` files: they share the server and its resets, and the
 * `chromium-mock` project runs them one at a time on one worker
 * (`tests/chat/mock-server.ts`).
 */

const agentDir = useMockServer();

// The prompts a turn STOPS on — tool approvals, the batch bar, AskUserQuestion,
// MCP elicitation (capability rows I-01..I-04, DOR-1214). Each drives a turn
// that PARKS waiting for an answer, and `POST /api/test/reset` tears every
// tracked session down: a parked turn living on a concurrent worker would be
// disposed mid-click. See the module header.
registerInteractivePromptTests({ apiUrl: MOCK_API_URL, agentDir });

// A prompt answered from a route that is not the session's (DOR-1330). Same
// reason as the suite above: it parks a turn and then LEAVES the session, so the
// turn has to survive a navigation with no concurrent reset.
registerAskAnywhereTests({ apiUrl: MOCK_API_URL, agentDir });

// A prompt nobody answered in time, which WAITS rather than dying (DOR-1350).
// Same lock again: it parks a turn, leaves the session, and answers it from
// another route.
registerAskParksTests({ apiUrl: MOCK_API_URL, agentDir });
