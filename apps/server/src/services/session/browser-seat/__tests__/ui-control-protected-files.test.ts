/**
 * QA rows B and C on a session's own canvas (DOR-4060): from a chat standing in
 * the data folder or the home folder, `open_canvas`, `open_file` and `open_diff`
 * refuse a protected file before anything is written, and `read_canvas_document`
 * never reads one out, even from a row recorded before this fix or a file
 * swapped for a hard link after it was opened.
 *
 * A real canvas writer over an in-memory database and real files in a fixture
 * home with dummy values only: HOME, DORK_HOME and CLAUDE_CONFIG_DIR stay in it.
 * The real boundary is initialised at the fixture root, so the file route's own
 * guard runs as it does in production.
 *
 * `control_ui` takes no level: the gate in front of it lets the call through at
 * every level that has the tool (Act and Full among them), so one run of the
 * handler stands for each. The Codex leg is the runtime surface, the only door
 * Codex and OpenCode have.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import type { RawSessionEvent } from '../../session-state-projector.js';
import {
  CanvasDocumentStore,
  CanvasService,
  sessionScope,
  setCanvasService,
} from '../../../canvas/index.js';
import { CapabilityToolError } from '../../../core/capabilities/index.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { controlUi, type UiCallerContext } from '../ui-control.js';
import { readSessionCanvasDocument } from '../read-canvas-document.js';
import { uiTurnFacts } from '../ui-turn-facts.js';

const reach = vi.hoisted(() => ({ emitted: [] as RawSessionEvent[] }));
vi.mock('../session-reach.js', () => ({
  emitToSession: (_sessionId: string, event: RawSessionEvent) => {
    reach.emitted.push(event);
    return true;
  },
}));

const SESSION = 'sess-4060';
const CANARY = 'TOKEN=dor-4060-dummy-canary';

let root: string;
let home: string;
let dork: string;
let agent: string;
let db: Db;
let canvas: CanvasService;

/** Run `control_ui` and report a refusal as a value. */
async function control(
  args: Record<string, unknown>,
  caller: UiCallerContext
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  try {
    return { payload: await controlUi(args, caller), isError: false };
  } catch (err) {
    if (err instanceof CapabilityToolError) {
      return { payload: err.payload as Record<string, unknown>, isError: true };
    }
    throw err;
  }
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor4060-ui-')));
  home = path.join(root, 'home');
  dork = path.join(home, '.dork');
  agent = path.join(root, 'agents', 'qa');
  fs.mkdirSync(dork, { recursive: true });
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(dork, 'host.key'), CANARY);
  fs.writeFileSync(path.join(dork, 'config.json'), `{"x":"${CANARY}"}`);
  fs.writeFileSync(path.join(agent, 'notes.md'), 'notes ok');
  vi.stubEnv('HOME', home);
  vi.stubEnv('DORK_HOME', dork);
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-fixture'));
  await initBoundary(root);
  db = createDb(':memory:');
  runMigrations(db);
  canvas = new CanvasService({
    documents: new CanvasDocumentStore(db),
    channels: { publish: () => {}, viewers: () => 0 },
  });
  setCanvasService(canvas);
  reach.emitted.length = 0;
  uiTurnFacts.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.$client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const SURFACES = [
  ['a Claude Code chat', false],
  ['a Codex chat (the runtime surface)', true],
] as const;

describe.each(SURFACES)('from %s', (_name, fromRuntimeSurface) => {
  const caller = (cwd: string): UiCallerContext => ({
    sessionId: SESSION,
    cwd,
    ...(fromRuntimeSurface ? { fromRuntimeSurface } : {}),
  });

  it.each([
    [
      'open_canvas file',
      { action: 'open_canvas', content: { type: 'file', sourcePath: 'host.key' } },
    ],
    [
      'open_canvas markdown',
      { action: 'open_canvas', content: { type: 'markdown', content: '', sourcePath: 'host.key' } },
    ],
    ['open_file', { action: 'open_file', sourcePath: 'config.json' }],
    ['open_diff', { action: 'open_diff', sourcePath: 'host.key' }],
  ])(
    'row B: %s from a chat in the data folder is refused with nothing written',
    async (_n, args) => {
      const applied = vi.spyOn(canvas, 'apply');
      const { payload, isError } = await control(args, caller(dork));
      expect(isError).toBe(true);
      expect(payload).toMatchObject({ success: false, code: 'PROTECTED_FILE' });
      expect(String(payload.error)).toMatch(/is a protected file/);
      expect(applied).not.toHaveBeenCalled();
      expect(reach.emitted).toHaveLength(0);
    }
  );

  it('row B: the same from a chat in the home folder', async () => {
    const { payload } = await control(
      { action: 'open_file', sourcePath: '.dork/host.key' },
      caller(home)
    );
    expect(payload).toMatchObject({ success: false, code: 'PROTECTED_FILE' });
    expect(reach.emitted).toHaveLength(0);
  });

  it('row C: a hard link to host.key in the agent’s own folder is refused at open', async () => {
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'hk-link.txt'));
    const { payload } = await control(
      { action: 'open_file', sourcePath: 'hk-link.txt' },
      caller(agent)
    );
    expect(payload).toMatchObject({ success: false, code: 'LINKED_FILE' });
    expect(reach.emitted).toHaveLength(0);
  });

  it('control: a plain file in the agent’s own folder opens and reads back', async () => {
    const { payload, isError } = await control(
      { action: 'open_file', sourcePath: 'notes.md' },
      caller(agent)
    );
    expect(isError).toBe(false);
    const read = (await readSessionCanvasDocument(String(payload.documentId), caller(agent))) as {
      content: unknown;
    };
    expect(read.content).toBe('notes ok');
  });
});

describe('read_canvas_document never reads a protected file out', () => {
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

  it('row B: a row recorded in the data folder before this fix', async () => {
    const id = recordRow('host.key', dork);
    const read = (await readSessionCanvasDocument(id, { sessionId: SESSION, cwd: dork })) as {
      content: unknown;
      reason?: string;
    };
    expect(read.content).toBeNull();
    expect(read.reason).toMatch(/is a protected file/);
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });

  it('row C: a file swapped for a hard link after it was opened', async () => {
    const id = recordRow('notes.md', agent);
    fs.rmSync(path.join(agent, 'notes.md'));
    fs.linkSync(path.join(dork, 'host.key'), path.join(agent, 'notes.md'));
    const read = (await readSessionCanvasDocument(id, { sessionId: SESSION, cwd: agent })) as {
      content: unknown;
      reason?: string;
    };
    expect(read.content).toBeNull();
    expect(read.reason).toMatch(/more than one hard link/);
    expect(JSON.stringify(read)).not.toContain(CANARY);
  });
});
