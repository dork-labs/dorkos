/**
 * The connector binding reads the turn under the SDK's session id, fixed when the binding opens,
 * while the turn's level and its outside-words note are kept under the id the turn was SENT with
 * (DOR-4587). The binding carries the turn's record to its own id as it opens, so the send gate
 * reads THIS turn: not an older, clean turn already kept under the SDK id (a turn calling a
 * connector before the room runner carries the record), and not nothing at all (an SDK id the
 * one-shot rekey never reached).
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRuntime, MessageOpts } from '@dorkos/shared/agent-runtime';
import type { StreamEvent } from '@dorkos/shared/types';
import type { ServerPrincipalProof } from '../../../connectors/principal/server-principal.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';
import type { ConnectorRuntimeTools } from '../../connector-tools.js';
import { recordTurnLevels } from '../../../core/turn-power/turn-levels.js';
import { noteRoomTurnWords } from '../../../core/turn-power/outside-words.js';
import { turnReadOutsideWords } from '../../../core/turn-power/outsider-turn.js';
import { resetChosenTurns } from '../../../core/turn-power/full-autonomy.js';
import { resetLiveOutsiderTurns } from '../../../core/turn-power/live-outsider-turns.js';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';
import { claudeConnectorTurn } from '../connector-turn-context.js';

let counter = 0;
const fresh = (label: string) => `carry-${label}-${(counter += 1)}`;

/** Record one turn sent under `sessionId`, as the runtime registry's wrapper does. */
async function ran(sessionId: string, opts?: MessageOpts) {
  const runtime = recordTurnLevels(
    {
      type: 'claude-code',
      getCapabilities: () => CLAUDE_CODE_CAPABILITIES,
      async *sendMessage(): AsyncGenerator<StreamEvent> {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    } as unknown as AgentRuntime,
    () => 'bypassPermissions'
  );
  for await (const _event of runtime.sendMessage(sessionId, 'hi', opts)) {
    // drain
  }
}

/** A binding port that opens and resolves any turn. */
function tools(): ConnectorRuntimeTools {
  const principal = { claims: { kind: 'runtime' } } as unknown as ServerPrincipalProof;
  const principals: ConnectorRuntimePrincipalPort = {
    openTurn: vi.fn().mockResolvedValue({
      bindingId: 'binding-1',
      bearer: 'made-up-bearer',
      expiresAt: '2099-01-01T00:00:00.000Z',
      renewalPermit: {} as never,
    }),
    renew: vi.fn(),
    resolve: vi.fn().mockResolvedValue({ status: 'resolved', principal }),
    revoke: vi.fn().mockResolvedValue(undefined),
  };
  return {
    principals,
    listenerUrl: 'http://127.0.0.1:4341/mcp',
    agentToolsUrl: 'http://127.0.0.1:4341/agent-mcp',
    isConnectorCapabilityId: () => true,
    createLeaseSupervisor: () => ({ assertUsable: () => {}, stop: () => {} }) as never,
  };
}

/**
 * Open a connector binding for a turn sent under `sentSessionId` whose SDK id is `sdkId`, built the
 * way the Claude Code runtime builds it for every turn.
 */
async function openBinding(sentSessionId: string, sdkId: string) {
  const context = claudeConnectorTurn(
    tools(),
    { agentPath: '/agents/wren' },
    { session: { sdkSessionId: sdkId }, sessionId: sentSessionId, cwd: '/agents/wren' }
  )!;
  await context.resolvePrincipal();
  await context.revoke('turn_terminal');
}

beforeEach(() => {
  resetChosenTurns();
  resetLiveOutsiderTurns();
});
afterEach(() => {
  resetChosenTurns();
  resetLiveOutsiderTurns();
});

describe("the connector binding reads this turn's record under the SDK id", () => {
  it('a marked turn over an older clean turn kept under the SDK id', async () => {
    const sdkId = fresh('sdk');
    const sent = fresh('sent');
    await ran(sdkId); // an earlier, clean turn already kept under the SDK id
    await ran(sent, { carriedMarks: { outsider: true } }); // this turn, sent under its own id
    expect(turnReadOutsideWords(sdkId, undefined)).toBe(false);
    await openBinding(sent, sdkId);
    expect(turnReadOutsideWords(sdkId, undefined)).toBe(true);
  });

  it("a relayed turn's outside-words note, under an SDK id nothing carried it to", async () => {
    const sdkId = fresh('sdk');
    const sent = fresh('sent');
    noteRoomTurnWords(sent, true);
    await ran(sent);
    expect(turnReadOutsideWords(sdkId, undefined)).toBe(false);
    await openBinding(sent, sdkId);
    expect(turnReadOutsideWords(sdkId, undefined)).toBe(true);
  });

  it('a clean turn stays clean under the SDK id', async () => {
    const sdkId = fresh('sdk');
    const sent = fresh('sent');
    await ran(sent);
    await openBinding(sent, sdkId);
    expect(turnReadOutsideWords(sdkId, undefined)).toBe(false);
  });
});
