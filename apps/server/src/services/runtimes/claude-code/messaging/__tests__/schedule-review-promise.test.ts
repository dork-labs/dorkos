import { describe, expect, it, vi } from 'vitest';
import { createCanUseTool, type ToolApprovalContext } from '../interactive-handlers.js';
import type { InteractiveSession } from '../interaction-wait.js';

describe('the Accept edits schedule review promise', () => {
  it('keeps automatic tools but immediately refuses a command that needs a person', async () => {
    const session: InteractiveSession & { permissionMode: 'acceptEdits' } = {
      permissionMode: 'acceptEdits',
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
    expect(await gate('Read', { file_path: '/tmp/sample.txt' }, context('read'))).toMatchObject({
      behavior: 'allow',
    });
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
});
