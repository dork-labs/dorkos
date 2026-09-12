/**
 * `documentId` survives the MCP layer, and targets the document it names.
 *
 * **Driven through the REAL SDK server and a real client**, because that is the
 * only place the defect was visible. `UiCommandSchema` is the union the handler
 * parses, but it is not what the model is allowed to send: the SDK builds the
 * tool's advertised JSON Schema from `CONTROL_UI_INPUT` and validates every call
 * against it, so a field present in the union and absent from that constant is
 * accepted by the client, dropped in transit, and gone by the time any handler
 * runs. Nothing fails — the tool answers `success` and simply acts on the wrong
 * document.
 *
 * So this file asserts two things no unit test of the handler could: that
 * `documentId` is ADVERTISED, and that the value a client sends ARRIVES.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Removing `documentId` from `CONTROL_UI_INPUT` reddens both cases: the
 *   advertised properties lose it, and the targeted update lands on the author's
 *   own last document instead of the one it named.
 *
 * @vitest-environment node
 * @module services/runtimes/claude-code/mcp-tools/tests/control-ui-document-id
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { noopLogger } from '@dorkos/shared/logger';
import { capabilityMcpTools } from '../capability-mcp-tools.js';
import { composeRegistry } from '../../../../core/capabilities/index.js';
import { uiTurnFacts } from '../../../../session/index.js';
import { uiDomain } from '../../../../session/browser-seat/ui-capabilities.js';
import { setRoomService } from '../../../../rooms/index.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../../rooms/__tests__/room-test-harness.js';

const ANA = '/agents/ana';
const SESSION = 'sess-control-ui';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
});

/** A json document — no dedupe key, so each open is a distinct target. */
const jsonContent = (label: string) => ({ type: 'json', data: { label }, title: label });

describe('control_ui through the real MCP layer', () => {
  let harness: RoomHarness;
  let roomId: string;
  let ana: string;
  let client: Client;

  beforeEach(async () => {
    harness = createRoomHarness({ agents, runner: scriptedRunner(() => null) });
    setRoomService(harness.service);
    roomId = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;

    // The production construction: `control_ui` is a `ui` capability, projected
    // onto the in-session SDK server exactly as `createDorkOsToolServer` does it.
    // Which room this turn answers in is the runtime-neutral turn fact the
    // trigger binds, so the handler reads it from the session id and nothing
    // else (spec `canvas-agent-seat` §5).
    uiTurnFacts.clear();
    uiTurnFacts.bindTurn(SESSION, { roomTurn: { roomId, authorId: ana, turnId: 'turn-1' } });
    const registry = composeRegistry([uiDomain], { logger: noopLogger });
    const server = createSdkMcpServer({
      name: 'dorkos',
      version: '1.0.0',
      tools: capabilityMcpTools(registry, 'in-session', async () => ({ sessionId: SESSION })),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'canvas-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  });

  /** Call `control_ui` the way a model does, and read its JSON answer back. */
  async function controlUi(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = (await client.callTool({
      name: 'control_ui',
      arguments: args,
    })) as CallToolResult;
    const text = result.content.find((block) => block.type === 'text');
    return JSON.parse((text as { text: string }).text) as Record<string, unknown>;
  }

  it('advertises `documentId` on the tool a model can see', async () => {
    const { tools } = await client.listTools();
    const controlUiTool = tools.find((tool) => tool.name === 'control_ui');
    expect(controlUiTool).toBeDefined();
    const properties = (controlUiTool?.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(
      Object.keys(properties ?? {}),
      'the model cannot send a field the tool does not advertise'
    ).toContain('documentId');
  });

  it('targets the named document rather than the author’s last one', async () => {
    const first = await controlUi({ action: 'open_canvas', content: jsonContent('first') });
    const second = await controlUi({ action: 'open_canvas', content: jsonContent('second') });
    // `second` is now this author's last-touched document, so a bare update
    // would land there — which is what makes the assertion below able to fail.
    expect(second.documentId).not.toBe(first.documentId);

    const updated = await controlUi({
      action: 'update_canvas',
      documentId: first.documentId,
      content: jsonContent('first, revised'),
    });

    expect(updated).toMatchObject({ success: true, documentId: first.documentId });
    expect(harness.service.canvas.get(roomId, first.documentId as string)?.title).toBe(
      'first, revised'
    );
    // …and the one it did NOT name is untouched.
    expect(harness.service.canvas.get(roomId, second.documentId as string)?.title).toBe('second');
  });

  it('closes the named document rather than the author’s last one', async () => {
    const first = await controlUi({ action: 'open_canvas', content: jsonContent('first') });
    const second = await controlUi({ action: 'open_canvas', content: jsonContent('second') });

    await controlUi({ action: 'close_canvas', documentId: first.documentId });

    expect(harness.service.canvas.get(roomId, first.documentId as string)).toBeNull();
    expect(harness.service.canvas.get(roomId, second.documentId as string)).not.toBeNull();
  });

  it('still falls back to the author’s own last document when none is named', async () => {
    await controlUi({ action: 'open_canvas', content: jsonContent('first') });
    const second = await controlUi({ action: 'open_canvas', content: jsonContent('second') });

    const updated = await controlUi({
      action: 'update_canvas',
      content: jsonContent('the last one I opened'),
    });

    expect(updated.documentId).toBe(second.documentId);
  });
});
