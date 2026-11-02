/**
 * The task contract speaks the schedule file's Claude-shaped mode vocabulary.
 * The ordinary simulator deliberately declares disjoint ids to catch hardcoded
 * session UIs; keep that profile unchanged outside this isolated child server.
 * Only its mode declaration changes here. All execution stays scripted and
 * the composed API, identity checks and mode validation remain real.
 */
import { TEST_MODE_CAPABILITIES } from '../../../../services/runtimes/test-mode/runtime-constants.js';
import { CLAUDE_CODE_CAPABILITIES } from '../../../../services/runtimes/claude-code/runtime-constants.js';

TEST_MODE_CAPABILITIES.permissionModes = CLAUDE_CODE_CAPABILITIES.permissionModes;
await import('../../../../index.js');
