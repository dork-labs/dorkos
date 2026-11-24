/**
 * Loads the server's harness consent module when a test file loads, not inside its first test.
 *
 * `runHarnessSync` reaches `../server/services/harness/project-with-consent.js`
 * through a lazy `import()`, and that module's graph reaches deep into the server
 * (turn power, the Claude Code folder settings). Compiling it cold takes about
 * 2.5 s on an idle laptop, so whichever test in a file ran the sync first spent
 * half of vitest's 5 s budget on it, and timed out on a busy CI shard (DOR-4518).
 * Imported for its side effect at the top of a test file, the same work happens
 * while the file loads, where no per-test timeout applies, and every test then
 * finds the module cached.
 *
 * @module cli/__tests__/preload-harness-server
 */
import '../../server/services/harness/project-with-consent.js';
