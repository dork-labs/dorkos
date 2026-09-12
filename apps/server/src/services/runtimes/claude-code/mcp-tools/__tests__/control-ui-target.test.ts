/**
 * `control_ui.target` — an agent putting a document on a room from its own
 * session (spec `canvas-agent-seat` §9).
 *
 * **Driven through the REAL SDK server and a real client**, for the reason
 * `control-ui-document-id.test.ts` next door gives: the SDK builds the tool's
 * advertised JSON Schema from `CONTROL_UI_INPUT` and validates every call
 * against it, so a field present in `UiCommandSchema` and absent from that
 * constant is accepted by the client, dropped in transit, and gone by the time
 * any handler runs — the tool answers `success` and puts the document on the
 * wrong surface. `documentId` hit that trap once already, which is why the first
 * case here asserts the field is ADVERTISED and every other case asserts a value
 * a client sent ARRIVED.
 *
 * The room service is real, over a real SQLite database, so "wrote a row on that
 * room" is read out of the table and "posted one line" out of the log.
 *
 * Seeded defects, each run red before the code stood:
 *
 * - Removing `target` from `CONTROL_UI_INPUT` reddens the advertised case and
 *   every write case with it: the document lands on the session's own canvas.
 * - Dropping the `requireMembership` call in `applyTargeted` reddens the
 *   non-member case with a row on a room the agent is not in.
 * - Keying the derived turn id on the session alone (no room id) reddens "two
 *   rooms get one allowance each" at the fourth write overall.
 * - Leaving `n` still across a boundary reddens "the next turn gets fresh
 *   allowances": the reused id carries the previous turn's spend.
 * - Finishing every open ledger rather than only the `session:` ones reddens
 *   "a room turn's own ledger is untouched".
 * - Answering `null` for a missing `sdkSessionId` — the old fall-through —
 *   reddens "refuses rather than falling onto this session's own canvas": the
 *   document lands here and the tool reports success.
 *
 * @vitest-environment node
 * @module services/runtimes/claude-code/mcp-tools/tests/control-ui-target
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { getUiTools, type UiToolSession } from '../ui-tools.js';
import type { McpToolDeps } from '../types.js';
import { setRoomService } from '../../../../rooms/index.js';
import {
  disposeProjector,
  getOrCreateProjector,
} from '../../../../session/session-state-projector.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../../../rooms/__tests__/room-test-harness.js';

const ANA = '/agents/ana';
const BEN = '/agents/ben';
const agents = agentLookupFor({
  [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' },
  [BEN]: { name: 'ben', displayName: 'Ben', responseMode: 'always' },
});

/** The session id every case drives its turn boundary on. */
const SESSION_ID = 'session-ana-1';

/** A json document — no dedupe key, so each open is a distinct write. */
const jsonDoc = (label: string) => ({ type: 'json', data: { label }, title: label });

describe('control_ui target through the real MCP layer', () => {
  let harness: RoomHarness;
  /** A channel Ana is in. */
  let backend: string;
  /** A second channel Ana is in, so two rooms can be targeted in one turn. */
  let design: string;
  /** A channel Ana is NOT in. */
  let secret: string;
  let ana: string;
  let client: Client;
  let session: UiToolSession;

  beforeEach(async () => {
    harness = createRoomHarness({
      agents,
      runner: scriptedRunner(() => null),
      // Pinned to a literal: the spec's own number, so "the fourth is refused"
      // is a claim about the rule rather than about whatever config says today.
      maxCanvasOpsPerTurn: 3,
    });
    setRoomService(harness.service);
    backend = harness.service.createRoom(
      { kind: 'channel', title: 'Backend', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    design = harness.service.createRoom(
      { kind: 'channel', title: 'Design', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    secret = harness.service.createRoom(
      { kind: 'channel', title: 'Secret', members: [], agentPaths: [BEN] },
      harness.human
    ).id;
    ana = harness.authors.resolveAgent(ANA, 'Ana').id;

    // A ONE-ON-ONE session: no `roomTurn`, so nothing here would reach a room
    // without `target`. The directory is what identifies the agent, exactly as
    // it does for the relay sender and the in-session capability principal.
    session = { eventQueue: [], sdkSessionId: SESSION_ID, cwd: ANA };
    const server = createSdkMcpServer({
      name: 'dorkos',
      version: '1.0.0',
      tools: getUiTools({} as McpToolDeps, session),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'target-probe', version: '0.0.0' });
    await Promise.all([server.instance.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    disposeProjector(SESSION_ID);
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

  /** End the calling session's turn the way the projector really does. */
  function endTurn(): void {
    getOrCreateProjector(SESSION_ID).ingest({ type: 'turn_end' } as never);
  }

  /** The canvas lines in one room's log. */
  function canvasLines(roomId: string) {
    return harness.service
      .listEntries(roomId, harness.human, { limit: 100 })
      .filter((entry) => entry.body.canvas !== undefined);
  }

  it('advertises `target` on the tool a model can see', async () => {
    const { tools } = await client.listTools();
    const controlUiTool = tools.find((tool) => tool.name === 'control_ui');
    const properties = (controlUiTool?.inputSchema as { properties?: Record<string, unknown> })
      .properties;
    expect(
      Object.keys(properties ?? {}),
      'the model cannot send a field the tool does not advertise'
    ).toContain('target');
  });

  it('puts the document on a room the agent is a member of', async () => {
    const answer = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('the chart'),
      target: { roomId: backend },
    });

    expect(answer).toMatchObject({ success: true, target: 'room', roomId: backend });
    const documents = harness.service.canvas.list(backend);
    expect(documents).toHaveLength(1);
    expect(documents[0]?.title).toBe('the chart');
    expect(documents[0]?.authorId).toBe(ana);
    // The session's own canvas stays empty: the document went to the room, and
    // this window has nothing to reveal.
    expect(session.eventQueue).toHaveLength(0);
  });

  it('answers a room the agent is not in exactly as a room that does not exist', async () => {
    const notAMember = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('the chart'),
      target: { roomId: secret },
    });
    const noSuchRoom = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('the chart'),
      target: { roomId: 'room-that-never-was' },
    });

    expect(notAMember).toMatchObject({ success: false, target: 'room' });
    expect(notAMember.reason).toContain('No such room');
    expect(noSuchRoom.reason, 'a room id must not be something an agent can probe with').toBe(
      notAMember.reason
    );
    expect(harness.service.canvas.list(secret)).toHaveLength(0);
  });

  it('refuses the fourth write to one room in one turn, and says what the limit is', async () => {
    for (let n = 0; n < 3; n += 1) {
      const ok = await controlUi({
        action: 'open_canvas',
        content: jsonDoc(`chart ${n}`),
        target: { roomId: backend },
      });
      expect(ok, `write ${n} should be inside the ceiling`).toMatchObject({ success: true });
    }

    const refused = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('one too many'),
      target: { roomId: backend },
    });

    expect(refused).toMatchObject({ success: false });
    expect(refused.reason).toContain('3');
    expect(harness.service.canvas.list(backend)).toHaveLength(3);
  });

  it('gives two rooms one allowance each in the same turn', async () => {
    for (let n = 0; n < 3; n += 1) {
      await controlUi({
        action: 'open_canvas',
        content: jsonDoc(`backend ${n}`),
        target: { roomId: backend },
      });
    }
    // The fourth write OVERALL, and the first to this room: a ceiling keyed on
    // the session alone would refuse it.
    const other = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('design 0'),
      target: { roomId: design },
    });

    expect(other).toMatchObject({ success: true, roomId: design });
    expect(harness.service.canvas.list(design)).toHaveLength(1);
  });

  it('posts one coalesced line per room at the end of the turn, and none before', async () => {
    await controlUi({
      action: 'open_canvas',
      content: jsonDoc('first'),
      target: { roomId: backend },
    });
    await controlUi({
      action: 'open_canvas',
      content: jsonDoc('second'),
      target: { roomId: backend },
    });
    await controlUi({
      action: 'open_canvas',
      content: jsonDoc('over here'),
      target: { roomId: design },
    });

    expect(canvasLines(backend), 'nothing is said until the turn ends').toHaveLength(0);
    expect(canvasLines(design)).toHaveLength(0);

    endTurn();

    const backendLines = canvasLines(backend);
    expect(backendLines).toHaveLength(1);
    expect(backendLines[0]?.body.canvas?.ops).toHaveLength(2);
    expect(canvasLines(design)).toHaveLength(1);
  });

  it('gives the next turn fresh allowances', async () => {
    for (let n = 0; n < 3; n += 1) {
      await controlUi({
        action: 'open_canvas',
        content: jsonDoc(`chart ${n}`),
        target: { roomId: backend },
      });
    }
    endTurn();

    const afterBoundary = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('a new turn'),
      target: { roomId: backend },
    });

    expect(afterBoundary).toMatchObject({ success: true });
    expect(harness.service.canvas.list(backend)).toHaveLength(4);
  });

  it('leaves a room turn’s own ledger for the room runner to finish', async () => {
    // The same session, now taking a ROOM turn — which carries its own turn id
    // and is finished by the runner's collector, never by the boundary. It ALSO
    // targets another room, so the boundary really does have something to close:
    // without that, `finishTargetedTurns` returns before it reads a ledger at
    // all and this case could not tell the two namespaces apart.
    session.roomTurn = { roomId: design, authorId: ana, turnId: 'room-turn-1' };
    await controlUi({ action: 'open_canvas', content: jsonDoc('in the room') });
    await controlUi({
      action: 'open_canvas',
      content: jsonDoc('over there'),
      target: { roomId: backend },
    });

    endTurn();

    // The targeted room's line is posted…
    expect(canvasLines(backend)).toHaveLength(1);
    // …and the ROOM turn's own ledger is still open, waiting for its runner.
    expect(
      harness.service.canvas.ledgerFor('room-turn-1'),
      'a room turn’s ledger is not the boundary’s to close'
    ).toHaveLength(1);
    expect(canvasLines(design)).toHaveLength(0);

    harness.service.canvas.finishTurn('room-turn-1');
    expect(canvasLines(design)).toHaveLength(1);
  });

  it('refuses rather than falling onto this session’s own canvas', async () => {
    // A session whose canonical id has not arrived has no key to charge the
    // ceiling against and none to close a ledger on. The old answer fell
    // through: the document landed on this session's OWN canvas and the tool
    // said `success` with no mention that `target` had been dropped — the one
    // thing §10 forbids, reporting success for something that did not happen.
    delete session.sdkSessionId;

    const answer = await controlUi({
      action: 'open_canvas',
      content: jsonDoc('the chart'),
      target: { roomId: backend },
    });

    expect(answer).toMatchObject({ success: false, target: 'room', roomId: backend });
    expect(answer.reason).toContain('has not been given its id yet');
    expect(harness.service.canvas.list(backend)).toHaveLength(0);
    // …and nothing was pushed at this window either.
    expect(session.eventQueue).toHaveLength(0);
  });

  it('ignores a target on an action a room has no surface for, and says so', async () => {
    const answer = await controlUi({
      action: 'show_toast',
      message: 'done',
      target: { roomId: backend },
    });

    expect(answer).toMatchObject({ success: true, action: 'show_toast' });
    expect(answer.targetIgnored).toContain('canvas');
    // It ran where it was going to run, and the room got nothing.
    expect(session.eventQueue).toHaveLength(1);
    expect(harness.service.canvas.list(backend)).toHaveLength(0);
  });
});
