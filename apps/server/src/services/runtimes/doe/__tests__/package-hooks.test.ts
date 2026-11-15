/**
 * DOR-4379 probe for the Dork runtime: an installed package's shell guard
 * refuses a matching `shell` call in every mode, Full included, and the
 * guard's own words reach the model. Real guard processes; real package on disk,
 * allowed through the runner's consent seam.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext, ToolDescriptor } from '@dorkos/doe';
import {
  makeGuardProject,
  type GuardProject,
} from '../../shared/policy/__tests__/package-hook-fixture.js';

import { DoeApprovals } from '../approvals.js';

let project: GuardProject;
beforeEach(() => {
  project = makeGuardProject();
  project.install([{ event: 'PreToolUse', matcher: 'Bash', command: project.guardCommand }]);
});
afterEach(() => project.cleanup());

const MODES = ['default', 'acceptEdits', 'bypassPermissions'] as const;
const BLOCKED = ['git stash', 'pkill -f vite'];

describe('Dork runtime: shell guards', () => {
  const shell: ToolDescriptor = {
    name: 'shell',
    description: 'Run a command',
    schema: {},
    execute: async () => ({ content: [] }),
  };
  function run(mode: string, command: string) {
    const controller = new AbortController();
    const context: ToolContext = {
      sessionId: 'doe-session',
      callId: 'call',
      scope: 'child:builder',
      workingDirectory: project.dir,
      signal: controller.signal,
      emit: () => {},
    };
    return new DoeApprovals().callback(mode, () => {}, controller.signal)(
      shell,
      { command },
      context
    );
  }

  for (const mode of MODES) {
    it.each(BLOCKED)(`refuses %s in ${mode}, with the guard's reason`, async (command) => {
      const decision = await run(mode, command);
      expect(decision).toMatchObject({ decision: 'deny' });
      expect(typeof decision === 'object' && decision.reason).toMatch(/^Blocked: /);
    });
  }

  it('lets a non-matching command through Full', async () => {
    expect(await run('bypassPermissions', 'git status')).toBe('allow');
  });
});
