/**
 * @vitest-environment node
 *
 * The `'runtime-default'` ceiling holds a turn from Wi-Fi, a relayed message
 * and a stranger's words to each runtime's own default mode. That is only a
 * cap if no runtime's default is a mode that runs tools without asking (Auto,
 * or `bypassPermissions`-style "never asks"). A runtime that declared one would
 * quietly lift every one of those caps, so this fails first.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import { resolveCeilingLevel } from '@dorkos/shared/permission-semantics';

import { CLAUDE_CODE_CAPABILITIES } from '../claude-code/runtime-constants.js';
import {
  CODEX_APP_SERVER_PERMISSION_MODES,
  CODEX_CAPABILITIES,
} from '../codex/runtime-constants.js';
import { DOE_CAPABILITIES } from '../doe/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../opencode/runtime-constants.js';

const DECLARED: Array<[string, RuntimeCapabilities['permissionModes']]> = [
  ['claude-code', CLAUDE_CODE_CAPABILITIES.permissionModes],
  ['codex (SDK)', CODEX_CAPABILITIES.permissionModes],
  ['codex (app server)', CODEX_APP_SERVER_PERMISSION_MODES],
  ['opencode', OPENCODE_CAPABILITIES.permissionModes],
  ['doe', DOE_CAPABILITIES.permissionModes],
];

describe("each runtime's default mode is one that asks or only reads", () => {
  it.each(DECLARED)('%s', (_name, declared) => {
    const level = resolveCeilingLevel(declared, 'runtime-default');
    expect(level.auto).not.toBe(true);
    // Either it asks before acting, or it cannot change anything at all.
    expect(level.asks === 'never' && level.reach !== 'read').toBe(false);
  });
});
