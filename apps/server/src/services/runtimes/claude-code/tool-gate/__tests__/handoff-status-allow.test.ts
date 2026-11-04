/**
 * A post's answer sends a chat to `room_handoff_status` (DOR-3778), so the read must run unasked for
 * a chat with an agent identity, Never ask included, and for no chat without one.
 */
import { describe, expect, it, vi } from 'vitest';
import { inSessionToolName } from '../../mcp-tools/tool-exposure.js';
import { NEVER_ASK_MODE_ID } from '../../runtime-constants.js';
import { dorkosAutoAllows } from '../auto-allow.js';
import { neverAskAllows } from '../never-ask-hook.js';

const TOOL = inSessionToolName('room_handoff_status');
const SDK_SERVER = { source: 'sdk' } as never;
const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } as never;
const agent = () => Promise.resolve({ identity: { agentPath: '/agents/bo', displayName: 'Bo' } });
const nobody = () => Promise.resolve({ identity: undefined });

describe('room_handoff_status', () => {
  it('runs unasked at Never ask for a chat with an agent identity', async () => {
    const session = { permissionMode: NEVER_ASK_MODE_ID } as never;
    await expect(neverAskAllows(session, TOOL, {}, SDK_SERVER, agent, log)).resolves.toBe(true);
  });

  it('runs unasked at Default for a chat with an agent identity', async () => {
    const session = { permissionMode: 'default' } as never;
    await expect(dorkosAutoAllows(session, TOOL, {}, SDK_SERVER, agent, log)).resolves.toBe(true);
  });

  it('does not run unasked for a chat with no agent identity', async () => {
    const session = { permissionMode: 'default' } as never;
    await expect(dorkosAutoAllows(session, TOOL, {}, SDK_SERVER, nobody, log)).resolves.toBe(false);
  });
});
