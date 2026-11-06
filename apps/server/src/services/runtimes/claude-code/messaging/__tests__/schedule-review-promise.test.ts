import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanUseTool, type ToolApprovalContext } from '../interactive-handlers.js';
import type { InteractiveSession } from '../interaction-wait.js';

let root: string;
let cwd: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'schedule-review-')));
  cwd = path.join(root, 'work');
  mkdirSync(cwd);
  writeFileSync(path.join(cwd, 'sample.txt'), 'inside');
  writeFileSync(path.join(root, 'outside.txt'), 'outside');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the DorkOS unattended permission gate at Accept edits', () => {
  it('allows an in-folder Read and immediately refuses escalated Bash without a pending approval', async () => {
    const session: InteractiveSession & { permissionMode: 'acceptEdits' } = {
      permissionMode: 'acceptEdits',
      cwd,
      unattended: true,
      pendingInteractions: new Map(),
      eventQueue: [],
      eventQueueNotify: vi.fn(),
    };
    const gate = createCanUseTool(session, { debug() {}, info() {} });
    const context = (toolUseID: string): ToolApprovalContext => ({
      toolUseID,
      signal: new AbortController().signal,
    });
    // The CLI owns its shell auto-allow decisions (including touch). This test
    // deliberately calls the DorkOS gate only for a command escalated to it.
    expect(
      await gate('Read', { file_path: path.join(cwd, 'sample.txt') }, context('read'))
    ).toMatchObject({ behavior: 'allow' });
    expect(await gate('Bash', { command: 'shasum sample.txt' }, context('command'))).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Nobody is available'),
    });
    expect(session.pendingInteractions.size).toBe(0);
    expect(session.eventQueue).toMatchObject([
      {
        type: 'permission_denied',
        data: { toolName: 'Bash', reasonType: 'no_approval_surface' },
      },
    ]);
  });

  it('refuses an outside-root Read on a timer run without a pending approval', async () => {
    const session: InteractiveSession & { permissionMode: 'acceptEdits' } = {
      permissionMode: 'acceptEdits',
      cwd,
      unattended: true,
      pendingInteractions: new Map(),
      eventQueue: [],
      eventQueueNotify: vi.fn(),
    };
    const gate = createCanUseTool(session, { debug() {}, info() {} });
    expect(
      await gate(
        'Read',
        { file_path: path.join(root, 'outside.txt') },
        {
          toolUseID: 'outside-read',
          signal: new AbortController().signal,
        }
      )
    ).toMatchObject({
      behavior: 'deny',
      message: expect.stringContaining('Nobody is available'),
    });
    expect(session.pendingInteractions.size).toBe(0);
    expect(session.eventQueue).toMatchObject([
      {
        type: 'permission_denied',
        data: { toolName: 'Read', reasonType: 'no_approval_surface' },
      },
    ]);
  });
});
