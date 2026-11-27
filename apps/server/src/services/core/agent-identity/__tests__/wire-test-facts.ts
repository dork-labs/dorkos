/**
 * Wire the agent facts port for a test file, as boot does (spec
 * `computer-side-starts-alone` §5.3), so computer-side code under test reads
 * homes, git's kill switch, prompt switches and package reads from the real
 * space side. Imported for its side effect, after the file's own `vi.mock`s
 * (which vitest hoists), so a mocked owner is the one the port reads.
 *
 * @module services/core/agent-identity/__tests__/wire-test-facts
 */
import { wireAgentFacts } from '../../../../startup/agent-facts.js';

wireAgentFacts();
