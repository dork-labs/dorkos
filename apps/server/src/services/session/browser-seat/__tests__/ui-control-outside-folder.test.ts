/**
 * A session canvas opened on a local file outside the agent's folder answers
 * with an error naming the path, instead of success and an empty pane (DOR-3519).
 *
 * The app reads a session canvas's local file through `/api/files/raw` and
 * `/api/files/content`, both confined to the chat's folder by `resolveWithinCwd`.
 * So a `src` or `sourcePath` outside it, or a link inside it that points out,
 * can never show; the call has to say so when it is made. Nothing here widens
 * what the canvas serves: the same file copied into the folder still opens.
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
  db.$client.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const MEDIA = ['image', 'pdf', 'audio', 'video', 'model3d', 'csv'] as const;

describe('a local file outside the agent folder (DOR-3519)', () => {
  it.each(MEDIA)('open_canvas %s with an outside src is an error naming the path', async (type) => {
    const src = path.join(outside, 'clip.mp4');
    const { payload, isError } = await control({ action: 'open_canvas', content: { type, src } });
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
    expect(String(payload.error)).toContain(src);
    expect(String(payload.error)).toContain('copy it into your folder');
    // Refused before anything is written: no document exists to send a window.
    expect(canvas.list(sessionScope(SESSION))).toEqual([]);
  });

  it.each([
    ['a file:// src', { type: 'video', src: '' }],
    ['a link inside the folder that points out', { type: 'video', src: 'link/clip.mp4' }],
  ])('refuses %s too', async (_name, content) => {
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
    const { payload, isError } = await control(args());
    expect(isError).toBe(true);
    expect(payload.code).toBe('OUTSIDE_FOLDER');
  });

  it.each([
    ['a relative src', { action: 'open_canvas', content: { type: 'video', src: 'clip.mp4' } }],
    [
      'an absolute src inside',
      { action: 'open_canvas', content: { type: 'video', src: 'AGENT/clip.mp4' } },
    ],
    ['open_file inside', { action: 'open_file', sourcePath: 'notes.md' }],
    [
      'a web src',
      { action: 'open_canvas', content: { type: 'image', src: 'https://example.com/a.png' } },
    ],
  ])('still opens %s', async (_name, args) => {
    const resolved = JSON.parse(JSON.stringify(args).replace('AGENT/', `${agent}/`));
    const { isError } = await control(resolved);
    expect(isError).toBe(false);
  });
});
