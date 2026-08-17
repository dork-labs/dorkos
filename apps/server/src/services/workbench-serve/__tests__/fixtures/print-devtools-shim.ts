/**
 * Print the emitted DevTools shim to stdout, so a test can run it through the
 * compiler the dev server actually uses (`tsx`) instead of the one the test
 * runner uses. See `devtools-shim-page.test.ts`.
 *
 * @module services/workbench-serve/__tests__/fixtures/print-devtools-shim
 */
import { DEVTOOLS_AGENT_SCRIPT } from '../../devtools-shim.js';

process.stdout.write(DEVTOOLS_AGENT_SCRIPT);
