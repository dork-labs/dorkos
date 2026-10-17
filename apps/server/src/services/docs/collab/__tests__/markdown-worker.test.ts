/**
 * The markdown worker and the server's handle on it (DOR-2984): the right file
 * is found in every kind of build, conversions run in a real worker thread,
 * a base from another doc is told apart from any other failure, and a worker
 * that dies fails only what it held.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as Y from 'yjs';
import { MarkdownWorkerClient, MarkdownWorkerError } from '../markdown-worker-client.js';
import { MARKDOWN_WORKER_FILE, resolveMarkdownWorkerEntry } from '../worker-entry.js';
import { makeWorker } from './collab-harness.js';

const dirs: string[] = [];
const clients: MarkdownWorkerClient[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'markdown-worker-')));
  dirs.push(dir);
  return dir;
}

/** A module URL for a file in `dir`, as the bundled server's own URL would be. */
function moduleIn(dir: string): string {
  return pathToFileURL(path.join(dir, 'index.js')).href;
}

describe('resolveMarkdownWorkerEntry', () => {
  it('prefers the worker shipped beside the bundle, and its unpacked twin in a packaged app', async () => {
    const root = scratch();
    const packed = path.join(root, 'app.asar', 'dist', 'server');
    const unpacked = path.join(root, 'app.asar.unpacked', 'dist', 'server');
    mkdirSync(packed, { recursive: true });
    mkdirSync(unpacked, { recursive: true });
    writeFileSync(path.join(unpacked, MARKDOWN_WORKER_FILE), '');
    expect(await resolveMarkdownWorkerEntry(root, moduleIn(packed))).toBe(
      path.join(unpacked, MARKDOWN_WORKER_FILE)
    );

    const plain = path.join(root, 'cli', 'server');
    mkdirSync(plain, { recursive: true });
    writeFileSync(path.join(plain, MARKDOWN_WORKER_FILE), '');
    expect(await resolveMarkdownWorkerEntry(root, moduleIn(plain))).toBe(
      path.join(plain, MARKDOWN_WORKER_FILE)
    );
  });

  it('uses the compiled sibling in the server’s own build', async () => {
    const dir = scratch();
    writeFileSync(path.join(dir, 'markdown-worker.js'), '');
    expect(await resolveMarkdownWorkerEntry(dir, moduleIn(dir))).toBe(
      path.join(dir, 'markdown-worker.js')
    );
  });

  it('says so when a build carries no worker at all', async () => {
    const dir = scratch();
    await expect(resolveMarkdownWorkerEntry(dir, moduleIn(dir))).rejects.toThrow(
      MARKDOWN_WORKER_FILE
    );
  });
});

describe('MarkdownWorkerClient', () => {
  it('seeds, merges and serializes a doc in a real worker thread', async () => {
    const client = makeWorker();
    clients.push(client);
    const state = await client.seed('# Title\n\nBody.\n');
    expect(await client.serialize(state)).toContain('Body.');

    const merged = await client.merge(state, '# Title\n\nBody, changed.\n', state);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, state);
    Y.applyUpdate(doc, merged.update);
    expect(await client.serialize(Y.encodeStateAsUpdate(doc))).toContain('Body, changed.');
    expect(merged.markdown).toContain('Body, changed.');
  });

  it('names a base from another doc as such', async () => {
    const client = makeWorker();
    clients.push(client);
    const a = await client.seed('Doc A.\n');
    const b = await client.seed('Doc B.\n');
    const failure = await client.merge(b, 'Doc B, clobbered.\n', a).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(MarkdownWorkerError);
    expect((failure as MarkdownWorkerError).code).toBe('BASE_MISMATCH');
  });

  it('fails what a dead worker held, and starts a fresh one for the next request', async () => {
    const dir = scratch();
    const dying = path.join(dir, 'dying.mjs');
    writeFileSync(dying, 'process.exit(3);\n');
    let entry = dying;
    const client = new MarkdownWorkerClient({ resolveEntry: async () => entry });
    clients.push(client);

    await expect(client.seed('x\n')).rejects.toMatchObject({ code: 'FAILED' });
    entry = await resolveMarkdownWorkerEntry(scratch());
    expect(await client.serialize(await client.seed('Back.\n'))).toContain('Back.');
  });
});

describe('MarkdownWorkerClient queue', () => {
  it('fails only the request a hung worker was running; the ones waiting run on a fresh worker', async () => {
    const dir = scratch();
    const hang = path.join(dir, 'hang.mjs');
    writeFileSync(
      hang,
      "import { parentPort } from 'node:worker_threads'; parentPort.on('message', () => {});\n"
    );
    const real = await resolveMarkdownWorkerEntry(scratch());
    let entry = hang;
    const client = new MarkdownWorkerClient({
      resolveEntry: async () => entry,
      requestTimeoutMs: 300,
    });
    clients.push(client);

    const first = client.seed('First.\n');
    const second = client.seed('Second.\n');
    // The second request waits behind the first: switching the entry now
    // means the fresh worker after the timeout is the real one.
    entry = real;
    await expect(first).rejects.toMatchObject({ code: 'FAILED' });
    expect(await client.serialize(await second)).toContain('Second.');
  });
});
