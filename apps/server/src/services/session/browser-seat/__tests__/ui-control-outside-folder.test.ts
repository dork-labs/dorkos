/**
 * A room canvas opened on a local file outside the agent's folder answers with
 * an error naming the path (DOR-3519). A room copies what its canvas shows to
 * every other member, so the call has to refuse when it is made.
 *
 * The person's own one-on-one window is not asked this (Security's ruling): it
 * opens an outside-folder file exactly as it did before.
 *
 * Real files in a temp tree, a real boundary at its root, a real canvas writer
 * over an in-memory database.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import {
  CanvasDocumentStore,
  CanvasService,
  sessionScope,
  setCanvasService,
} from '../../../canvas/index.js';
import { CapabilityToolError } from '../../../core/capabilities/index.js';
import { initBoundary } from '../../../../lib/boundary.js';
import { controlUi } from '../ui-control.js';
import { uiTurnFacts } from '../ui-turn-facts.js';

const SESSION = 'sess-3519';
const ROOM = 'room-3519';

let root: string;
let agent: string;
let outside: string;
let db: Db;
let canvas: CanvasService;

/** Run `control_ui` from the agent's folder and report a refusal as a value. */
async function control(
  args: Record<string, unknown>
): Promise<{ payload: Record<string, unknown>; isError: boolean }> {
  try {
    return { payload: await controlUi(args, { sessionId: SESSION, cwd: agent }), isError: false };
  } catch (err) {
    if (err instanceof CapabilityToolError) {
      return { payload: err.payload as Record<string, unknown>, isError: true };
    }
    throw err;
  }
}

/** Make this session's turn a room turn, placed in the agent's folder. */
function inRoom(): void {
  uiTurnFacts.bindTurn(SESSION, {
    roomTurn: { roomId: ROOM, authorId: 'agent-media', turnId: 'turn-1', cwd: agent },
  });
}

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dor3519-ui-')));
  agent = path.join(root, 'agents', 'media');
  outside = path.join(root, 'drive');
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  for (const dir of [agent, outside]) {
    fs.writeFileSync(path.join(dir, 'clip.mp4'), 'made-up video bytes');
    fs.writeFileSync(path.join(dir, 'notes.md'), 'made-up notes');
  }
  fs.symlinkSync(outside, path.join(agent, 'link'));
  vi.stubEnv('HOME', path.join(root, 'home'));
  vi.stubEnv('DORK_HOME', path.join(root, 'home', '.dork'));
  vi.stubEnv('CLAUDE_CONFIG_DIR', path.join(root, 'claude-fixture'));
  await initBoundary(root);
  db = createDb(':memory:');
  runMigrations(db);
  canvas = new CanvasService({
    documents: new CanvasDocumentStore(db),
    channels: { publish: () => {}, viewers: () => 0 },
  });
  setCanvasService(canvas);
  uiTurnFacts.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  uiTurnFacts.clear();
  db.$client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const MEDIA = ['image', 'pdf', 'audio', 'video', 'model3d', 'csv'] as const;

describe("a local file outside the agent folder, on a room's canvas (DOR-3519)", () => {
  it.each(MEDIA)('open_canvas %s with an outside src is an error naming the path', async (type) => {
    inRoom();
    const src = path.join(outside, 'clip.mp4');
    const { payload, isError } = await control({ action: 'open_canvas', content: { type, src } });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
    expect(String(payload.error)).toContain(src);
    expect(String(payload.error)).toContain('copy it into your folder');
    // Refused before anything is written: no document exists in the room.
    expect(canvas.list(ROOM)).toEqual([]);
  });

  it.each([
    ['a file:// src', { type: 'video', src: '' }],
    ['a link inside the folder that points out', { type: 'video', src: 'link/clip.mp4' }],
  ])('refuses %s too', async (_name, content) => {
    inRoom();
    const src = content.src === '' ? `file://${path.join(outside, 'clip.mp4')}` : content.src;
    const { payload, isError } = await control({
      action: 'open_canvas',
      content: { ...content, src },
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
  });

  it.each([
    ['open_file', () => ({ action: 'open_file', sourcePath: path.join(outside, 'notes.md') })],
    ['open_file through a link', () => ({ action: 'open_file', sourcePath: 'link/notes.md' })],
    ['open_file up and out', () => ({ action: 'open_file', sourcePath: '../../drive/notes.md' })],
    [
      'open_canvas file',
      () => ({
        action: 'open_canvas',
        content: { type: 'file', sourcePath: path.join(outside, 'notes.md') },
      }),
    ],
  ])('%s outside the folder is an error too', async (_name, args) => {
    inRoom();
    const { payload, isError } = await control(args());
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
  });

  it('a canvas verb targeted at a room from a one-on-one chat is refused the same way', async () => {
    const src = path.join(outside, 'clip.mp4');
    const { payload, isError } = await control({
      action: 'open_canvas',
      content: { type: 'video', src },
      target: { roomId: ROOM },
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
  });
});

describe('the person’s own one-on-one window opens what it did before (Security, DOR-3519)', () => {
  it.each(MEDIA)('open_canvas %s with an outside src still opens', async (type) => {
    const src = path.join(outside, 'clip.mp4');
    const { payload, isError } = await control({ action: 'open_canvas', content: { type, src } });
    expect(isError).toBe(false);
    expect(payload.success).toBe(true);
    expect(canvas.list(sessionScope(SESSION))).toHaveLength(1);
  });

  it.each([
    ['open_file', { action: 'open_file', sourcePath: 'OUTSIDE/notes.md' }],
    [
      'open_canvas file',
      { action: 'open_canvas', content: { type: 'file', sourcePath: 'OUTSIDE/notes.md' } },
    ],
    [
      'a link that points out',
      { action: 'open_canvas', content: { type: 'video', src: 'link/clip.mp4' } },
    ],
  ])('%s outside the folder still opens', async (_name, args) => {
    const resolved = JSON.parse(JSON.stringify(args).replace('OUTSIDE/', `${outside}/`));
    const { isError } = await control(resolved);
    expect(isError).toBe(false);
  });

  it.each([
    ['a relative src', { action: 'open_canvas', content: { type: 'video', src: 'clip.mp4' } }],
    ['open_file inside', { action: 'open_file', sourcePath: 'notes.md' }],
    [
      'a web src',
      { action: 'open_canvas', content: { type: 'image', src: 'https://example.com/a.png' } },
    ],
  ])('still opens %s', async (_name, args) => {
    const { isError } = await control(args);
    expect(isError).toBe(false);
  });
});
