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
 * `--allow-hooks` and the other consent verbs also load the consent door and the
 * config store it writes through (`consent-config-store.ts`), lazily too. Cold,
 * those pushed the first consent test past 5 s on CI, and its late finish then
 * wired the door to that test's home while the next test ran (DOR-5459). The
 * sync also hands the harness its package reads (`harness-package-facts.ts`),
 * loaded here for the same reason.
 *
 * @module cli/__tests__/preload-harness-server
 */
import '../../server/services/harness/project-with-consent.js';
import '../../server/services/harness/agent-facts.js';
import '../../server/services/marketplace/package-facts.js';
import '../../server/services/core/config-manager.js';
import '../../server/services/core/operator/config-write.js';
import '../../server/services/core/approvals/computer-asks/consent-config.js';
import '../../server/services/core/approvals/computer-asks/hook-decisions.js';
import '../../server/services/core/approvals/computer-asks/global-sharing.js';
