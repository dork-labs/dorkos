import { registerCompactionTests } from './chat/compaction.js';
import { registerComposerEscapeAndImeTests } from './chat/composer-escape-and-ime.js';
import { MOCK_API_URL, useMockServer } from './chat/mock-server.js';
import { registerSessionReadStateTests } from './chat/session-read-state.js';
import { registerDorkBotSeedSurvivesReloadTests } from './dashboard-sidebar/dorkbot-seed-survives-reload.js';

/**
 * Session state, the composer and compaction, against the test-mode server.
 * One of the `chat-mock*.spec.ts` files: they share the server and its resets,
 * and the `chromium-mock` project runs them one at a time on one worker
 * (`tests/chat/mock-server.ts`).
 */

const agentDir = useMockServer();

// Cross-device read state for chat sessions (DOR-1040). `/api/test/reset`
// deletes every tracked session's transcript, so a suite that needs a
// transcript to survive a minute of browser work must never run beside another
// mock file. See the module header for the full argument.
registerSessionReadStateTests({ apiUrl: MOCK_API_URL, agentDir });

// What a session went through surviving a page load (DOR-1136). It needs the
// `error` scenario, which only this leg has, and the defect is about what a
// FRESH page connection is told, which no unit test can observe.
registerDorkBotSeedSurvivesReloadTests({ apiUrl: MOCK_API_URL, agentDir });

// The double-Escape clear on both fields, and Enter during an IME composition
// (DOR-948). Both suites flip `ui.composer.richText`, which is server-global —
// only the project's one sequential worker makes that safe. See the module
// header.
registerComposerEscapeAndImeTests({ apiUrl: MOCK_API_URL, agentDir });

// Compaction end to end (L-04, DOR-1215). It drives turns and a `/compact`
// against the shared test-mode server — see the module header.
registerCompactionTests({ apiUrl: MOCK_API_URL, agentDir });
