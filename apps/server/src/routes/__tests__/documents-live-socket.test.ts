/**
 * The live doc socket (DOR-2984), over a real WebSocket: it refuses while Docs
 * are off and for every doc the files routes would refuse, and an editor that
 * joins gets the doc, sees an agent's write land, and has its typing reach
 * the file.
 *
 * The upgrade is driven the way the router drives it (authorize, then complete
 * the handshake and `open`), without the router's credential gate, which has
 * its own suite (`upgrade-router.test.ts`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';
import { DOC_COLLAB_MESSAGE } from '@dorkos/shared/doc-collab';

const flags = vi.hoisted(() => ({ docs: true }));
vi.mock('../../services/core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'docs' ? { enabled: flags.docs } : undefined)),
    set: vi.fn(),
  },
}));

import { liveDocRoute } from '../documents-live-socket.js';
import { getDocCollab, initDocCollab, stopDocCollab } from '../../services/docs/collab/index.js';
import { InstallationFileWrites } from '../../services/canvas/doc-channel/writes/installation-file-writes.js';
import {
  handleMarkdownRequest,
  loadMarkdownModel,
} from '../../services/docs/collab/markdown-worker.js';
import { makeSpace, type TestSpace } from '../../services/docs/collab/__tests__/collab-harness.js';

let space: TestSpace;
let server: Server;
let port: number;
const sockets = new WebSocketServer({ noServer: true });

beforeEach(async () => {
  flags.docs = true;
  space = await makeSpace();
  initDocCollab({ dorkHome: space.dorkHome, writer: new InstallationFileWrites() });
  server = createServer();
  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const match = liveDocRoute.pattern.exec(url.pathname)!;
      const decision = await liveDocRoute.authorize({
        url,
        headers: req.headers,
        match,
        locals: {},
      });
      sockets.handleUpgrade(req, socket, head, (ws) => {
        if (decision.ok) decision.open(ws);
        else ws.close(4000 + decision.status, decision.message);
      });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  await stopDocCollab();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  space.cleanup();
});

/** An editor over a real socket. */
async function connect(rel: string, generation?: string) {
  const query = new URLSearchParams({
    cwd: space.space,
    path: rel,
    ...(generation ? { generation } : {}),
  });
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/documents/live?${query}`);
  const doc = new Y.Doc();
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  const hellos: string[] = [];
  ws.on('message', (data) => {
    const decoder = decoding.createDecoder(new Uint8Array(data as Buffer));
    const type = decoding.readVarUint(decoder);
    if (type === DOC_COLLAB_MESSAGE.note) {
      const note = JSON.parse(decoding.readVarString(decoder)) as {
        type: string;
        generation?: string;
      };
      if (note.type === 'hello' && note.generation) hellos.push(note.generation);
      return;
    }
    if (type !== DOC_COLLAB_MESSAGE.sync) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.readSyncMessage(decoder, encoder, doc, 'server');
    if (encoding.length(encoder) > 1) ws.send(encoding.toUint8Array(encoder));
  });
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'server' || ws.readyState !== WebSocket.OPEN) return;
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.writeUpdate(encoder, update);
    ws.send(encoding.toUint8Array(encoder));
  });
  ws.on('open', () => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.writeSyncStep1(encoder, doc);
    ws.send(encoding.toUint8Array(encoder));
  });
  const model = await loadMarkdownModel();
  const markdown = () => {
    const result = handleMarkdownRequest(model, {
      id: 0,
      op: 'serialize',
      state: Y.encodeStateAsUpdate(doc),
    });
    return result.op === 'serialize' ? result.markdown : '';
  };
  const type = (next: string) => {
    const result = handleMarkdownRequest(model, {
      id: 0,
      op: 'merge',
      state: Y.encodeStateAsUpdate(doc),
      markdown: next,
    });
    if (result.op === 'merge') Y.applyUpdate(doc, result.update, 'local');
  };
  return { ws, closed, markdown, type, hellos, doc };
}

describe('the live doc socket', () => {
  it('serves a doc to its editors, merges an agent’s write and writes typing to the file', async () => {
    const rel = space.write('live.md', '# Live\n\nFrom the file.\n');
    const editor = await connect(rel);
    await expect.poll(editor.markdown, { timeout: 5000 }).toContain('From the file.');

    const doc = { cwd: space.space, path: rel };
    const ada = { writer: { kind: 'agent' as const, name: 'Ada' }, sessionKey: 'ada' };
    await getDocCollab()!.read(doc, ada);
    editor.type('# Live\n\nFrom the file.\n\nTyped over the socket.\n');
    await expect
      .poll(() => readFileSync(path.join(space.space, rel), 'utf8'), { timeout: 5000 })
      .toContain('Typed over the socket.');

    // Ada writes from her read, which came before the typing: both survive.
    await getDocCollab()!.write(doc, '# Live, by Ada\n\nFrom the file.\n', ada);
    await expect.poll(editor.markdown, { timeout: 5000 }).toContain('# Live, by Ada');
    expect(editor.markdown()).toContain('Typed over the socket.');
    editor.ws.close();
  });

  it.each([
    ['Docs are off', 404, () => (flags.docs = false), 'off.md'],
    ['the file is not markdown', 415, () => undefined, 'notes.txt'],
    ['the file is missing', 404, () => undefined, 'missing.md'],
    ['the path leaves the space', 400, () => undefined, '../outside.md'],
  ])('refuses when %s', async (_why, status, arrange, rel) => {
    if (!rel.startsWith('missing') && !rel.startsWith('..')) space.write(rel, 'x\n');
    arrange();
    const editor = await connect(rel);
    expect(await editor.closed).toBe(4000 + status);
  });

  it('tells an editor holding another copy which copy this is, and closes it untouched', async () => {
    const rel = space.write('copy.md', '# Real\n');
    const first = await connect(rel);
    await expect.poll(first.markdown, { timeout: 5000 }).toContain('# Real');

    const old = await connect(rel, 'an-older-copy');
    await old.closed;
    expect(old.hellos).toEqual([first.hellos[0]]);
    expect(old.doc.getXmlFragment('prosemirror').length).toBe(0);
    first.ws.close();
  });

  it('refuses a cwd outside the boundary', async () => {
    const query = new URLSearchParams({ cwd: space.dorkHome, path: 'x.md' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/documents/live?${query}`);
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4403);
  });
});
