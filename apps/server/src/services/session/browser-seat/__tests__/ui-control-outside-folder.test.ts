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
import { setRoomRepoService, setRoomService } from '../../../rooms/index.js';
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

describe("a room's own folders, on that room's canvas (DOR-3519, Security)", () => {
  const OTHER = 'room-other';
  let rooms: string;
  let copy: string;
  let repo: string;
  let applied: unknown[];

  /** A room turn in ROOM, placed in the agent's folder with its copy of the room's files. */
  function inRoomWithFiles(): void {
    uiTurnFacts.bindTurn(SESSION, {
      roomTurn: {
        roomId: ROOM,
        authorId: 'agent-media',
        turnId: 'turn-1',
        cwd: agent,
        worktree: copy,
      },
    });
  }

  beforeEach(() => {
    rooms = path.join(root, 'home', '.dork', 'rooms');
    copy = path.join(rooms, ROOM, 'worktrees', 'media-0123abcd');
    repo = path.join(rooms, ROOM, 'repo');
    for (const dir of [
      copy,
      repo,
      path.join(rooms, OTHER, 'repo'),
      path.join(rooms, OTHER, 'worktrees', 'media-0123abcd'),
    ]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'notes.md'), 'made-up room notes');
    }
    fs.symlinkSync(outside, path.join(copy, 'link'));
    applied = [];
    // Only the two seams this path reads: where a room's shared files are, and
    // the room canvas writer, which records what reached it.
    setRoomRepoService({
      repoPathFor: (roomId: string) => path.join(rooms, roomId, 'repo'),
    } as never);
    setRoomService({
      handoffs: { reports: undefined },
      canvas: {
        apply: (input: unknown) => {
          applied.push(input);
          return { applied: true, documentId: 'doc-1', rev: 1, viewers: 0 };
        },
        list: () => [],
      },
    } as never);
  });

  it.each([
    ["markdown from the agent's own copy of the room's files", () => path.join(copy, 'notes.md')],
    ["markdown from the room's shared repo/", () => path.join(repo, 'notes.md')],
    ["markdown from the agent's own folder", () => 'notes.md'],
  ])('%s opens in a room turn', async (_name, sourcePath) => {
    inRoomWithFiles();
    const { payload, isError } = await control({
      action: 'open_canvas',
      content: { type: 'markdown', content: 'made-up room notes', sourcePath: sourcePath() },
    });
    expect(payload.code).toBeUndefined();
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ success: true, target: 'room', roomId: ROOM });
    expect(applied).toHaveLength(1);
  });

  it.each([
    ["another room's shared repo/", () => path.join(rooms, OTHER, 'repo', 'notes.md')],
    [
      "the agent's copy of another room's files",
      () => path.join(rooms, OTHER, 'worktrees', 'media-0123abcd', 'notes.md'),
    ],
    ['a link in the own copy that points out', () => path.join(copy, 'link', 'notes.md')],
    [
      'up and out of the own copy',
      () => path.join(copy, '..', '..', '..', OTHER, 'repo', 'notes.md'),
    ],
  ])('%s is refused', async (_name, sourcePath) => {
    inRoomWithFiles();
    const { payload, isError } = await control({ action: 'open_file', sourcePath: sourcePath() });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
    expect(applied).toEqual([]);
  });

  it("another room's files are refused even when the agent's folder contains the rooms folder", async () => {
    uiTurnFacts.bindTurn(SESSION, {
      roomTurn: {
        roomId: ROOM,
        authorId: 'agent-media',
        turnId: 'turn-1',
        cwd: root,
        worktree: copy,
      },
    });
    const { payload, isError } = await control({
      action: 'open_file',
      sourcePath: path.join(rooms, OTHER, 'repo', 'notes.md'),
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
  });

  it("a write targeted at another room does not carry this room's copy along", async () => {
    inRoomWithFiles();
    const { payload, isError } = await control({
      action: 'open_file',
      sourcePath: path.join(copy, 'notes.md'),
      target: { roomId: OTHER },
    });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
  });

  it.each([
    ['a url document', () => ({ action: 'open_canvas', content: { type: 'url', url: fileUrl() } })],
    [
      'a browser document',
      () => ({ action: 'open_canvas', content: { type: 'browser', url: fileUrl() } }),
    ],
    ['browser_navigate', () => ({ action: 'browser_navigate', url: fileUrl() })],
  ])('%s naming a file:// address outside is refused the same way', async (_name, args) => {
    inRoomWithFiles();
    const { payload, isError } = await control(args());
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
    expect(String(payload.error)).toContain(path.join(outside, 'notes.md'));
    expect(applied).toEqual([]);
  });

  /** A file:// address for the outside file. */
  function fileUrl(): string {
    return `file://${path.join(outside, 'notes.md')}`;
  }
});
