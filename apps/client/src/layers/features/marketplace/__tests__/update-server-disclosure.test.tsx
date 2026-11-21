/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { summarizeUpdateDisclosures } from '../ui/ConfirmUpdatesDialog';
import type { StaleInstallation } from '../lib/installed-updates';

describe('update server disclosure', () => {
  it.each([
    undefined,
    [{ id: 'sample-app', slots: [], hasServer: true }],
    [{ id: 'sample-app', slots: [] }],
  ])('never claims a server or unknown package runs nothing: %j', (extensions) => {
    const item = {
      check: {
        extensions,
        disclosed: {
          hooks: [],
          schedules: [],
          mcpServers: [],
          lspServers: [],
          monitors: [],
          executables: [],
          skillTools: [],
          skillCommands: [],
        },
      },
    } as unknown as StaleInstallation;
    expect(summarizeUpdateDisclosures([item])).not.toContain('runs nothing');
  });

  it('keeps the quiet wording for a checked package with no apps or effects', () => {
    const item = {
      check: {
        extensions: [],
        disclosed: {
          hooks: [],
          schedules: [],
          mcpServers: [],
          lspServers: [],
          monitors: [],
          executables: [],
          skillTools: [],
          skillCommands: [],
        },
      },
    } as unknown as StaleInstallation;
    expect(summarizeUpdateDisclosures([item])).toBe('The new version runs nothing on its own');
  });
});
