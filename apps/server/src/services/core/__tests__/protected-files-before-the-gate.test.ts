/**
 * DOR-4060: the protected-file and protected-folder refusals answer BEFORE the
 * permission gate, so no level, no card and no saved "Always allow" reaches a
 * protected file.
 *
 * Every action under test is set to Ask, the strictest level that still runs,
 * against a real `ApprovalService`. A protected or hard-linked file is refused
 * outright, with no approval minted, so there is nothing for anyone to approve.
 * On the hand-registered gate a plain folder still raises a card, which proves
 * the gate WOULD have asked there.
 * Claude Code's own card comes before DorkOS's server, so its `PreToolUse` hook
 * is asked the same, last.
 *
 * A fixture home with dummy values only: HOME, DORK_HOME and CLAUDE_CONFIG_DIR stay in it.
 *
 * @vitest-environment node
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalService } from '../approvals/index.js';
import {
  composeRegistry,
  initCapabilityTierGate,
  resetCapabilityTierGate,
  resetPermissionGate,
  type CapabilityRegistry,
} from '../capabilities/index.js';
import { askFor } from '../capabilities/__tests__/permission-gate-fixtures.js';
import { gateHandRegisteredMcpTools, type SdkMcpTool } from '../mcp-tool-gate.js';
import {
  CanvasDocumentStore,
  CanvasService,
  sessionScope,
  setCanvasService,
} from '../../canvas/index.js';
import { uiDomain } from '../../session/browser-seat/ui-capabilities.js';
import { roomsDomain } from '../../rooms/room-capabilities.js';
import { setRoomService } from '../../rooms/index.js';
import {
  agentLookupFor,
  createRoomHarness,
  scriptedRunner,
  type RoomHarness,
} from '../../rooms/__tests__/room-test-harness.js';
import { createProtectedFileHook } from '../../runtimes/claude-code/tool-gate/protected-file-hook.js';
// Registers the `session_start` early check, as the server's boot does.
import '../../runtimes/claude-code/mcp-tools/session-tools.js';

const CANARY = 'TOKEN=dor-4060-dummy-canary';
const SESSION = 'sess-4060-gate';
const ANA = '/agents/ana';

let root: string;
let home: string;
let dork: string;
let agent: string;
let approvals: ApprovalService;
let canvas: CanvasService;
let harness: RoomHarness;
let registry: CapabilityRegistry;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4060-gate-')));
  home = path.join(root, 'home');
  dork = path.join(home, '.dork');
  agent = path.join(root, 'agents', 'ana');
  fs.mkdirSync(dork, { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(dork, 'host.key'), CANARY);
  fs.writeFileSync(path.join(agent, 'notes.md'), 'notes ok');
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-fixture'));

  approvals = new ApprovalService(createTestDb());
  initCapabilityTierGate({ approvals });
  askFor(
    'session_start',
    'ui.control',
    'ui.read_canvas_document',
    'rooms.post',
    'rooms.read_canvas'
  );

  harness = createRoomHarness({
    agents: agentLookupFor({ [ANA]: { name: 'ana', displayName: 'Ana', responseMode: 'always' } }),
    runner: scriptedRunner(() => null),
  });
  setRoomService(harness.service);
  // After the harness, which installs a canvas writer of its own.
  canvas = new CanvasService({
    documents: new CanvasDocumentStore(createTestDb()),
    channels: { publish: () => {}, viewers: () => 0 },
  });
  setCanvasService(canvas);
  registry = composeRegistry([roomsDomain, uiDomain], {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    roomDeps: { rooms: harness.service },
  });
});

afterEach(() => {
  resetCapabilityTierGate();
  resetPermissionGate();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Ana's call through the capability registry, from a chat standing in `cwd`. */
async function invoke(id: string, input: Record<string, unknown>, cwd: string) {
  try {
    return {
      result: await registry.invoke(id, input, {
        identity: { agentPath: ANA, displayName: 'Ana' },
        sessionId: SESSION,
        cwd,
      } as Parameters<CapabilityRegistry['invoke']>[2]),
    };
  } catch (err) {
    return { error: err as { decision?: { outcome: string; payload: Record<string, unknown> } } };
  }
}

/** A file document on this session's canvas, recorded against `cwd`. */
function recordRow(sourcePath: string, cwd: string): string {
  const applied = canvas.apply({
    scope: sessionScope(SESSION),
    authorId: 'agent',
    command: { action: 'open_file', sourcePath },
    tree: { resolvedCwd: cwd, sourceLabel: null, treeKind: null, aheadOfMain: null },
    defaultTarget: 'active-in-view',
  });
  if (!applied.applied) throw new Error(applied.reason);
  return applied.documentId;
}

/** The refusal shape: denied, nobody can approve past it, and no card was minted. */
function expectRefusedBeforeTheGate(
  outcome: Awaited<ReturnType<typeof invoke>>,
  message: RegExp
): void {
  expect(outcome.error?.decision).toMatchObject({
    outcome: 'denied',
    payload: {
      approvable: false,
      reason: 'permission_blocked',
      message: expect.stringMatching(message),
    },
  });
  expect(approvals.listPending()).toHaveLength(0);
}

describe('at Ask, a protected file is refused with no card', () => {
  it.each([
    ['open_file', { action: 'open_file', sourcePath: 'host.key' }],
    [
      'open_canvas file',
      { action: 'open_canvas', content: { type: 'file', sourcePath: 'host.key' } },
    ],
    [
      'open_canvas markdown',
      { action: 'open_canvas', content: { type: 'markdown', content: '', sourcePath: 'host.key' } },
    ],
  ])('control_ui %s from a chat in the data folder', async (_n, input) => {
    expectRefusedBeforeTheGate(await invoke('ui.control', input, dork), /is a protected file/);
  });

  it.each([
    ['open_file', (src: string) => ({ action: 'open_file', sourcePath: src })],
    [
      'open_canvas file',
      (src: string) => ({ action: 'open_canvas', content: { type: 'file', sourcePath: src } }),
    ],
    [
      'open_canvas markdown',
      (src: string) => ({
        action: 'open_canvas',
        content: { type: 'markdown', content: '', sourcePath: src },
      }),
    ],
    [
      'open_canvas image',
      (src: string) => ({ action: 'open_canvas', content: { type: 'image', src } }),
    ],
    [
      'open_canvas pdf',
      (src: string) => ({ action: 'open_canvas', content: { type: 'pdf', src } }),
    ],
    [
      'open_canvas csv',
      (src: string) => ({ action: 'open_canvas', content: { type: 'csv', src } }),
    ],
    ['browser_navigate', (src: string) => ({ action: 'browser_navigate', url: src })],
    [
      'open_canvas url',
      (src: string) => ({
        action: 'open_canvas',
        content: { type: 'url', url: `file://${path.join(agent, src)}` },
      }),
    ],
  ])('control_ui %s of a hard link in the agent’s own folder', async (_n, input) => {
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'hk-link.txt'));
    expectRefusedBeforeTheGate(
      await invoke('ui.control', input('hk-link.txt'), agent),
      /more than one hard link/
    );
  });

  it('read_canvas_document of a row in the data folder', async () => {
    const id = recordRow('host.key', dork);
    expectRefusedBeforeTheGate(
      await invoke('ui.read_canvas_document', { documentId: id }, dork),
      /is a protected file/
    );
  });

  it('read_canvas_document of a file swapped for a hard link', async () => {
    const id = recordRow('notes.md', agent);
    fs.rmSync(path.join(agent, 'notes.md'));
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'notes.md'));
    expectRefusedBeforeTheGate(
      await invoke('ui.read_canvas_document', { documentId: id }, agent),
      /more than one hard link/
    );
  });

  it.each([
    ['host.key from the data folder', () => dork, 'host.key', /is a protected file/],
    [
      'a hard link in the agent’s own folder',
      () => agent,
      'hk-link.txt',
      /more than one hard link/,
    ],
  ])('post_to_room attachments: %s', async (_n, cwd, name, message) => {
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'hk-link.txt'));
    const roomId = harness.service.createRoom(
      { kind: 'channel', title: 'qa', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    expectRefusedBeforeTheGate(
      await invoke('rooms.post', { roomId, text: 'qa m1', attachments: [name] }, cwd()),
      message
    );
  });

  it('read_canvas of a room document swapped for a hard link', async () => {
    const roomId = harness.service.createRoom(
      { kind: 'channel', title: 'qa', members: [], agentPaths: [ANA] },
      harness.human
    ).id;
    const ana = harness.authors.resolveAgent(ANA, 'Ana').id;
    harness.service.canvas.apply({
      roomId,
      authorId: ana,
      turnId: 't',
      command: {
        action: 'open_canvas',
        content: { type: 'markdown', content: 'notes ok', sourcePath: 'notes.md' },
      },
      cwd: agent,
    });
    const [document] = harness.service.canvas.list(roomId);
    fs.rmSync(path.join(agent, 'notes.md'));
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'notes.md'));
    expectRefusedBeforeTheGate(
      await invoke('rooms.read_canvas', { roomId, documentId: document!.id }, agent),
      /more than one hard link/
    );
  });
});

describe('read_canvas for a room the caller is not in', () => {
  it('leaves the answer to the handler, which names no file', async () => {
    const roomId = harness.service.createRoom(
      { kind: 'channel', title: 'other', members: [], agentPaths: [] },
      harness.human
    ).id;
    harness.service.canvas.apply({
      roomId,
      authorId: harness.human,
      turnId: 't',
      command: {
        action: 'open_canvas',
        content: { type: 'markdown', content: 'notes ok', sourcePath: 'notes.md' },
      },
      cwd: agent,
    });
    const [document] = harness.service.canvas.list(roomId);
    fs.rmSync(path.join(agent, 'notes.md'));
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'notes.md'));
    const outcome = await invoke('rooms.read_canvas', { roomId, documentId: document!.id }, agent);
    expect(outcome.error?.decision).toBeUndefined();
    expect(JSON.stringify(outcome)).not.toMatch(/protected file|hard link/);
  });
});

describe('session_start through the hand-registered gate, at Ask', () => {
  let ran: number;
  const startTool = (): SdkMcpTool => ({
    name: 'session_start',
    description: 'Start a chat.',
    inputSchema: {},
    async handler() {
      ran += 1;
      return { content: [{ type: 'text' as const, text: '{}' }] };
    },
  });
  const start = async (cwd: string): Promise<Record<string, unknown>> => {
    const [gated] = gateHandRegisteredMcpTools([startTool()], async () => ({
      identity: { agentPath: agent, displayName: 'Ana', createdAt: '2026-11-09T00:00:00.000Z' },
    }));
    const result = (await gated!.handler({ cwd, prompt: 'x' }, undefined)) as CallToolResult;
    return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
  };
  beforeEach(() => {
    ran = 0;
  });

  it.each([
    ['the data folder', () => dork],
    ['the home folder', () => home],
  ])('a chat in %s is refused with no card', async (_n, cwd) => {
    expect(await start(cwd())).toMatchObject({ status: 'denied', approvable: false });
    expect(ran).toBe(0);
    expect(approvals.listPending()).toHaveLength(0);
  });

  it('control: the agent’s own folder raises a card', async () => {
    expect((await start(agent)).status).toBe('approval_required');
  });
});

describe("Claude Code's PreToolUse hook answers first, so no card and no saved Always allow reach it", () => {
  const hook = () =>
    createProtectedFileHook({ sessionId: () => SESSION, cwd: agent, agentPath: agent });
  const ask = (tool: string, input: Record<string, unknown>) =>
    hook()(
      {
        hook_event_name: 'PreToolUse',
        tool_name: `mcp__dorkos__${tool}`,
        tool_input: input,
      } as never,
      undefined,
      { signal: new AbortController().signal }
    );

  it.each([
    ['session_start into the data folder', 'session_start', () => ({ cwd: dork, prompt: 'x' })],
    ['session_start into the home folder', 'session_start', () => ({ cwd: home, prompt: 'x' })],
    [
      'open_file of a hard link',
      'control_ui',
      () => ({ action: 'open_file', sourcePath: 'hk-link.txt' }),
    ],
    [
      'post_to_room of a hard link',
      'post_to_room',
      () => ({ roomId: 'r', text: 'x', attachments: ['hk-link.txt'] }),
    ],
  ])('denies %s', async (_n, tool, input) => {
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'hk-link.txt'));
    expect(await ask(tool, input())).toMatchObject({
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' },
    });
  });

  it('denies read_canvas_document of a protected row', async () => {
    const id = recordRow('host.key', dork);
    expect(await ask('read_canvas_document', { documentId: id })).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('answers nothing for a plain file or another tool', async () => {
    expect(await ask('control_ui', { action: 'open_file', sourcePath: 'notes.md' })).toEqual({});
    expect(await ask('session_start', { cwd: agent, prompt: 'x' })).toEqual({});
    expect(await ask('room_handoff_status', {})).toEqual({});
  });
});
