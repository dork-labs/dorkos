/**
 * DOR-4522 for the Dork runtime: a `shell` call that writes inside an installed
 * package is refused in every mode, Full included, with no card, while an
 * ordinary write still runs at Full. The real shell guard process reads it.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ToolContext, ToolDescriptor } from '@dorkos/doe';
import { DoeApprovals } from '../approvals.js';

const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'doe-shell-protected-')));
const project = path.join(root, 'project');
const data = path.join(root, 'data');
const installed = path.join(data, 'plugins', 'acme');
const projectPlugin = path.join(project, '.dork', 'plugins', 'acme');
for (const folder of [
  project,
  installed,
  projectPlugin,
  path.join(project, 'build'),
  path.join(root, 'home'),
])
  mkdirSync(folder, { recursive: true });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const shell: ToolDescriptor = {
  name: 'shell',
  description: 'Run a command',
  schema: {},
  execute: async () => ({ content: [] }),
};

/** Ask the turn's real approval channel about one command, and keep what it emitted. */
async function ask(mode: string, command: string) {
  const controller = new AbortController();
  const events: StreamEvent[] = [];
  const context: ToolContext = {
    sessionId: 'doe-session',
    callId: 'call',
    scope: 'child:builder',
    workingDirectory: project,
    signal: controller.signal,
    emit: () => {},
  };
  const channel = new DoeApprovals();
  const pending = channel.callback(
    mode,
    (event) => events.push(event),
    controller.signal,
    false,
    new Set(),
    {
      cwd: project,
      data,
      home: path.join(root, 'home'),
      accounts: [],
      agentFolders: [project],
      agentHomes: [],
    }
  )(shell, { command }, context);
  // A card waits for a person; give the check a few seconds, then close the channel.
  let timer: NodeJS.Timeout | undefined;
  const decision = await Promise.race([
    pending,
    new Promise<'card'>((resolve) => (timer = setTimeout(() => resolve('card'), 10_000))),
  ]);
  clearTimeout(timer);
  channel.close();
  return { decision, events };
}

describe('Dork runtime: shell writes to an installed package', () => {
  it.each(['default', 'acceptEdits', 'bypassPermissions'])(
    'refuses one in %s mode, with no card',
    async (mode) => {
      const { decision, events } = await ask(mode, `touch ${installed}/skills/x`);
      expect(decision).toEqual({
        decision: 'deny',
        reason: expect.stringMatching(/protected file/),
      });
      expect(events).toEqual([]);
    },
    30_000
  );

  it('still lets an ordinary write run at Full', async () => {
    expect((await ask('bypassPermissions', `touch ${project}/notes.txt`)).decision).toBe('allow');
  }, 30_000);
});

// DOR-5249: removing or moving a folder refuses when a project's plugins are in it.
describe('Dork runtime: shell removals and moves of a folder holding a project’s plugins', () => {
  it.each([
    ['removing the project’s `.dork`', 'default', 'rm -rf .dork'],
    ['removing the project’s `.dork`', 'bypassPermissions', 'rm -rf .dork'],
    ['moving the project', 'bypassPermissions', `mv ${project} ${root}/moved`],
  ])(
    'refuses %s in %s mode, with no card',
    async (_label, mode, command) => {
      const { decision, events } = await ask(mode, command);
      expect(decision).toEqual({
        decision: 'deny',
        reason: expect.stringMatching(/protected file/),
      });
      expect(events).toEqual([]);
    },
    30_000
  );

  it('still lets an ordinary removal run at Full', async () => {
    expect((await ask('bypassPermissions', `rm -rf ${project}/build`)).decision).toBe('allow');
  }, 30_000);
});
