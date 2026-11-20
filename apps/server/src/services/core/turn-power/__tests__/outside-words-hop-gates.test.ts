/**
 * A turn another chat's words reached after that chat read words from outside the team carries the
 * outside-words note, not the mark (`launch.ts`, `session_start`). The gates that hold a raise,
 * an extension's self-approval and a write to another agent's setup read the note as they read
 * the mark (DOR-4587), so such a hop cannot do unasked what the mark exists to stop.
 *
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { recordTurnLevels } from '../turn-levels.js';
import { noteRoomTurnWords } from '../outside-words.js';
import { gateCallerOf } from '../../../tasks/agent-mode/agent-mode-escalation.js';
import { crossAgentRefusal, turnMarksOf } from '../../../tasks/approvals/cross-agent.js';
import { createCreateExtensionHandler } from '../../../runtimes/claude-code/mcp-tools/extension-create-tool.js';
import type { McpToolDeps } from '../../../runtimes/claude-code/mcp-tools/types.js';
import type { ToolCallContext } from '../../capabilities/tool-call-escalation.js';

const AGENT = {
  agentPath: '/agents/wren',
  displayName: 'Wren',
  createdAt: new Date().toISOString(),
};

let counter = 0;
const fresh = () => `hop-gates-${(counter += 1)}`;

/** Run one clean turn in a chat set to `stored`. */
async function ran(sessionId: string, stored: string) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => stored
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi')) {
    // drain
  }
}

/** A clean Full turn a hop from a chat that read outside words reached. */
async function hopTurn(): Promise<string> {
  const chat = fresh();
  noteRoomTurnWords(chat, true);
  await ran(chat, 'bypassPermissions');
  return chat;
}

afterEach(() => vi.restoreAllMocks());

describe('raising a mode (agent-mode gate)', () => {
  const callerIn = (sessionId: string) =>
    gateCallerOf({
      origin: 'session',
      sessionId,
      identity: AGENT,
      cwd: AGENT.agentPath,
    } as unknown as ToolCallContext);

  it('holds a hop turn as marked', async () => {
    expect(callerIn(await hopTurn()).marked).toBe(true);
  });

  it('leaves a clean turn unmarked', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions');
    expect(callerIn(chat).marked).toBe(false);
  });
});

describe("writing another agent's schedule (cross-agent gate)", () => {
  it('refuses a hop turn at Full and keeps the mark on what it writes', async () => {
    const chat = await hopTurn();
    const caller = { sessionId: chat, agentPath: AGENT.agentPath };
    expect(crossAgentRefusal(caller)).toMatchObject({ code: 'cross_agent_marked_turn' });
    expect(turnMarksOf(caller).outsider).toBe(true);
  });

  it('lets a clean Full turn through', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions');
    expect(crossAgentRefusal({ sessionId: chat, agentPath: AGENT.agentPath })).toBeNull();
  });
});

describe('creating an extension (self-approval at Full)', () => {
  /** Whether `create_extension` asked the manager to approve the new copy itself. */
  async function approvesItself(sessionId: string): Promise<boolean> {
    const createExtension = vi.fn(async () => ({ autoApproved: false }));
    const deps = { extensionManager: { createExtension } } as unknown as McpToolDeps;
    const handler = createCreateExtensionHandler(deps, () => ({
      agentPath: AGENT.agentPath,
      sessionId,
      chosenFull: true,
    }));
    await handler({ name: 'made-up-card' });
    const [opts] = createExtension.mock.calls[0] as unknown as [{ approveIfTrusted: boolean }];
    return opts.approveIfTrusted;
  }

  it('waits for a person on a hop turn', async () => {
    expect(await approvesItself(await hopTurn())).toBe(false);
  });

  it('approves itself on a clean Full turn', async () => {
    const chat = fresh();
    await ran(chat, 'bypassPermissions');
    expect(await approvesItself(chat)).toBe(true);
  });
});
