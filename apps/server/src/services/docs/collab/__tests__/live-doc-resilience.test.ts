/**
 * Live docs never lose a person's edits (DOR-2984 review): a save that fails
 * is retried rather than forgotten, an editor holding another copy of the doc
 * can never write into this one, and a doc reopened after it was dropped (or
 * after the server stopped) is the same copy, so editors that reconnect merge
 * through Yjs instead of starting over.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import { DOC_COLLAB_MESSAGE } from '@dorkos/shared/doc-collab';
import type { DocCollabService } from '../doc-collab-service.js';
import { DocVersionStore } from '../doc-versions.js';
import { MarkdownWorkerClient, MarkdownWorkerError } from '../markdown-worker-client.js';
import {
  makeService,
  makeSpace,
  TestEditor,
  workerEntry,
  type TestSpace,
} from './collab-harness.js';

let space: TestSpace;
let service: DocCollabService;
const services: DocCollabService[] = [];

beforeEach(async () => {
  space = await makeSpace();
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.stop()));
  space.cleanup();
});

function start(overrides: Parameters<typeof makeService>[1] = {}): DocCollabService {
  const made = makeService(space, overrides).service;
  services.push(made);
  return made;
}

function ref(rel: string) {
  return { cwd: space.space, path: rel };
}

function onDisk(rel: string): string {
  return readFileSync(path.join(space.space, rel), 'utf8');
}

/** A worker whose next `serialize` calls fail, as a crashed or timed-out worker's would. */
class FlakyWorker extends MarkdownWorkerClient {
  failures = 0;
  override async serialize(state: Uint8Array): Promise<string> {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new MarkdownWorkerError('FAILED', 'The markdown worker took too long.');
    }
    return super.serialize(state);
  }
}

describe('a save that fails', () => {
  it('is retried until the edits reach the file', async () => {
    const worker = new FlakyWorker({ resolveEntry: workerEntry });
    service = start({ worker });
    const rel = space.write('flaky.md', 'Before.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    worker.failures = 2;
    await person.type('Before.\n\nAfter a failed save.\n');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('After a failed save.');
  });

  it('keeps the edits through close, even when the last save fails once', async () => {
    const worker = new FlakyWorker({ resolveEntry: workerEntry });
    service = start({ worker, flushDelayMs: 60_000, flushMaxWaitMs: 60_000 });
    const rel = space.write('closing.md', 'Before.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await person.type('Before.\n\nTyped just before closing.\n');
    worker.failures = 1;
    person.leave();
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Typed just before closing.');
  });
});

describe('an editor holding another copy of the doc', () => {
  it('is told which copy this is and closed, and nothing it holds reaches the doc', async () => {
    service = start();
    const rel = space.write('copy.md', 'The real copy.\n');
    const doc = await service.resolve(ref(rel));
    const watcher = await TestEditor.join(service, doc);
    await expect.poll(() => watcher.markdown()).toContain('The real copy.');

    // An editor from an older load of this doc, with words of its own.
    const old = new Y.Doc();
    old.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('Old copy words.')]);
    const stale = await TestEditor.join(service, doc, { ydoc: old, generation: 'an-old-copy' });

    expect(stale.stale).toBe(true);
    expect(stale.closed).toBe(true);
    expect(await watcher.markdown()).not.toContain('Old copy words.');
  });

  it('is closed when it sends an update this copy cannot place, and the doc stays writable', async () => {
    service = start();
    const rel = space.write('poison.md', 'Clean.\n');
    const doc = await service.resolve(ref(rel));
    const editor = await TestEditor.join(service, doc);
    await expect.poll(() => editor.markdown()).toContain('Clean.');

    // An update built on items this copy never had.
    const elsewhere = new Y.Doc();
    elsewhere.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('base')]);
    const before = Y.encodeStateVector(elsewhere);
    elsewhere.getXmlFragment('prosemirror').insert(1, [new Y.XmlText('dangling')]);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, DOC_COLLAB_MESSAGE.sync);
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(elsewhere, before));
    editor.sendRaw(encoding.toUint8Array(encoder));
    expect(editor.closed).toBe(true);

    // An agent's merge still works: nothing is left waiting in the doc.
    const agent = { writer: { kind: 'agent' as const, name: 'Ada' }, sessionKey: 'ada' };
    await service.read(ref(rel), agent);
    await service.write(ref(rel), 'Clean, by Ada.\n', agent);
    const after = await TestEditor.join(service, doc);
    await expect.poll(() => after.markdown()).toContain('Clean, by Ada.');
  });
});

describe('a doc reopened after it was dropped', () => {
  it('is the same copy, so an editor that reconnects merges instead of starting over', async () => {
    service = start({ lingerMs: 0 });
    const rel = space.write('reopen.md', 'Shared.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await person.type('Shared.\n\nSaved before the drop.\n');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Saved before the drop.');
    const generation = person.generation;
    person.leave();
    await expect
      .poll(async () => (await service.read(ref(rel), { writer: { kind: 'agent' } })).live, {
        timeout: 3000,
      })
      .toBe(false);

    // Typed while away, then back.
    await person.type('Shared.\n\nSaved before the drop.\n\nTyped while away.\n');
    const back = await person.reconnect(service, doc);
    expect(back.stale).toBe(false);
    expect(back.generation).toBe(generation);
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Typed while away.');
    expect(onDisk(rel).match(/Saved before the drop\./g)).toHaveLength(1);
  });

  it('is the same copy after the server restarts', async () => {
    service = start();
    const rel = space.write('restart.md', 'Before the restart.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await person.type('Before the restart.\n\nFlushed.\n');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Flushed.');
    await service.stop();

    const restarted = start();
    await person.type('Before the restart.\n\nFlushed.\n\nTyped while it was down.\n');
    const back = await person.reconnect(restarted, await restarted.resolve(ref(rel)));
    expect(back.stale).toBe(false);
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Typed while it was down.');
    expect(onDisk(rel).match(/Flushed\./g)).toHaveLength(1);
  });

  it('is a new copy when the file changed while it was closed', async () => {
    service = start();
    const rel = space.write('changed.md', 'One.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await expect.poll(() => person.markdown()).toContain('One.');
    person.leave();
    await expect
      .poll(async () => (await service.read(ref(rel), { writer: { kind: 'agent' } })).live, {
        timeout: 3000,
      })
      .toBe(false);
    space.write('changed.md', 'Two, written while closed.\n');
    const back = await person.reconnect(service, doc);
    expect(back.stale).toBe(true);
  });
});

describe('a doc whose file is deleted while it is open', () => {
  it('tells its editors, keeps their text as a version, and stops trying to save', async () => {
    service = start({ watch: true });
    const rel = space.write('deleted.md', 'Kept words.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await expect.poll(() => person.markdown()).toContain('Kept words.');
    rmSync(path.join(space.space, rel));

    await expect
      .poll(() => person.notes.some((note) => note.type === 'gone'), { timeout: 5000 })
      .toBe(true);
    await person.type('Kept words.\n\nTyped after the delete.\n');
    const versions = new DocVersionStore(path.join(space.dorkHome, 'docs', 'versions'));
    await expect
      .poll(async () => (await versions.list(doc.scope)).length, { timeout: 5000 })
      .toBeGreaterThan(0);
    const [kept] = await versions.list(doc.scope);
    expect(await versions.read(doc.scope, kept!.id)).toContain('Kept words.');
    // Nothing recreates the file behind the person's back.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(path.join(space.space, rel))).toBe(false);
  });
});

describe('versions an agent write keeps', () => {
  it('are the file’s own bytes, not the editor’s rewrite of them', async () => {
    service = start();
    const raw = '- one\n- two\n';
    const rel = space.write('raw.md', raw);
    const doc = await service.resolve(ref(rel));
    await TestEditor.join(service, doc);
    const agent = { writer: { kind: 'agent' as const, name: 'Ada' }, sessionKey: 'ada' };
    await service.read(ref(rel), agent);
    await service.write(ref(rel), '- one\n- two\n- three\n', agent);
    const versions = new DocVersionStore(path.join(space.dorkHome, 'docs', 'versions'));
    const [kept] = await versions.list(doc.scope);
    expect(await versions.read(doc.scope, kept!.id)).toBe(raw);
  });
});

describe('an agent that read an open doc which then closed', () => {
  it('can still write it, though the file was never rewritten in the editor’s form', async () => {
    service = start({ lingerMs: 0 });
    const rel = space.write('normalized.md', '- one\n- two\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    const agent = { writer: { kind: 'agent' as const, name: 'Ada' }, sessionKey: 'ada' };
    const read = await service.read(ref(rel), agent);
    expect(read.markdown).not.toBe('- one\n- two\n');
    person.leave();
    await expect
      .poll(async () => (await service.read(ref(rel), { writer: { kind: 'agent' } })).live, {
        timeout: 3000,
      })
      .toBe(false);
    const result = await service.write(ref(rel), '- one\n- two\n- three\n', agent);
    expect(result).toMatchObject({ live: false, changed: true });
  });
});
