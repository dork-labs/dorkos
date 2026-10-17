/**
 * Live docs, second review (DOR-2984): a save whose conflict merge fails is
 * retried rather than dropped (and closing always keeps the text), a stale
 * editor never leaves a doc open with nobody in it, an agent cannot overwrite
 * a closed doc it never read, and two changes on disk in one save window
 * both merge correctly next to a person's unsaved typing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import { DocNotReadError, type DocCollabService } from '../doc-collab-service.js';
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

const ref = (rel: string) => ({ cwd: space.space, path: rel });
const onDisk = (rel: string) => readFileSync(path.join(space.space, rel), 'utf8');
const versionsOf = () => new DocVersionStore(path.join(space.dorkHome, 'docs', 'versions'));
const AGENT = { writer: { kind: 'agent' as const, name: 'Ada' }, sessionKey: 'ada' };

/** A worker whose next `merge` calls fail, as a timed-out worker's would. */
class FlakyMergeWorker extends MarkdownWorkerClient {
  failures = 0;
  override async merge(state: Uint8Array, markdown: string, base?: Uint8Array) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new MarkdownWorkerError('FAILED', 'The markdown worker took too long.');
    }
    return super.merge(state, markdown, base);
  }
}

describe('a save that meets a change on disk it cannot merge yet', () => {
  it('is retried, and both the typing and the change on disk reach the file', async () => {
    const worker = new FlakyMergeWorker({ resolveEntry: workerEntry });
    const service = start({ worker });
    const rel = space.write('conflict.md', 'Alpha.\n\nBeta.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await expect.poll(() => person.markdown()).toContain('Beta.');
    // Somebody writes the file while nothing is watching it; the next save meets a conflict.
    writeFileSync(path.join(space.space, rel), 'Alpha, from disk.\n\nBeta.\n');
    worker.failures = 1;
    await person.type('Alpha.\n\nBeta.\n\nTyped.\n');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Typed.');
    expect(onDisk(rel)).toContain('Alpha, from disk.');
  });

  it('keeps the text as a version when closing cannot merge it at all', async () => {
    const worker = new FlakyMergeWorker({ resolveEntry: workerEntry });
    const service = start({ worker, flushDelayMs: 60_000, flushMaxWaitMs: 60_000 });
    const rel = space.write('stuck.md', 'Alpha.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await person.type('Alpha.\n\nTyped before closing.\n');
    writeFileSync(path.join(space.space, rel), 'Alpha, from disk.\n');
    worker.failures = 100;
    person.leave();
    await expect
      .poll(async () => (await versionsOf().list(doc.scope)).map((v) => v.reason), {
        timeout: 8000,
      })
      .toContain('unsaved-edits');
    const [kept] = await versionsOf().list(doc.scope);
    expect(await versionsOf().read(doc.scope, kept!.id)).toContain('Typed before closing.');
  });
});

describe('an editor holding another copy of a closed doc', () => {
  it('does not leave the doc open with nobody in it', async () => {
    const service = start({ lingerMs: 0 });
    const rel = space.write('closed.md', 'Hello.\n');
    const old = new Y.Doc();
    const stale = await TestEditor.join(service, await service.resolve(ref(rel)), {
      ydoc: old,
      generation: 'an-old-copy',
    });
    expect(stale.stale).toBe(true);
    await expect
      .poll(async () => (await service.read(ref(rel), { writer: { kind: 'agent' } })).live, {
        timeout: 3000,
      })
      .toBe(false);
  });
});

describe('an agent writing a closed doc', () => {
  it('is refused when it never read the doc, and the file stays as it was', async () => {
    const service = start();
    const rel = space.write('unread.md', 'The person’s words.\n');
    await expect(service.write(ref(rel), 'Overwritten.\n', AGENT)).rejects.toBeInstanceOf(
      DocNotReadError
    );
    expect(onDisk(rel)).toBe('The person’s words.\n');
  });
});

describe('two changes on disk in one save window', () => {
  it('both merge, the first right next to unsaved typing', async () => {
    const service = start({ watch: true, flushDelayMs: 60_000, flushMaxWaitMs: 60_000 });
    const rel = space.write('twice.md', 'One.\n\nTwo.\n\nThree.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await expect.poll(() => person.markdown()).toContain('Three.');
    await person.type('One.\n\nTwo, typed by the person.\n\nThree.\n');

    writeFileSync(path.join(space.space, rel), 'One.\n\nTwo.\n\nThree, first agent edit.\n');
    await expect
      .poll(() => person.markdown(), { timeout: 5000 })
      .toContain('Three, first agent edit.');
    writeFileSync(
      path.join(space.space, rel),
      'One, second agent edit.\n\nTwo.\n\nThree, first agent edit.\n'
    );
    await expect
      .poll(() => person.markdown(), { timeout: 5000 })
      .toContain('One, second agent edit.');

    const shown = await person.markdown();
    expect(shown).toContain('Two, typed by the person.');
    expect(shown).toContain('Three, first agent edit.');
    expect(shown.match(/Three/g)).toHaveLength(1);
  });
});

describe('a server that stops before an open doc was saved', () => {
  it('still has the unsaved edits when it starts again', async () => {
    const first = start({ flushDelayMs: 60_000, flushMaxWaitMs: 60_000, persistDelayMs: 20 });
    const rel = space.write('crash.md', 'Saved.\n');
    const person = await TestEditor.join(first, await first.resolve(ref(rel)));
    await person.type('Saved.\n\nTyped, never saved.\n');
    // The server "crashes": its state on disk is all a new one gets.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onDisk(rel)).toBe('Saved.\n');

    const restarted = start();
    const back = await TestEditor.join(restarted, await restarted.resolve(ref(rel)));
    await expect.poll(() => back.markdown(), { timeout: 5000 }).toContain('Typed, never saved.');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Typed, never saved.');
  });

  it('does not trust a saved state that does not match the file', async () => {
    const first = start();
    const rel = space.write('corrupt.md', 'The real file.\n');
    const person = await TestEditor.join(first, await first.resolve(ref(rel)));
    await person.type('The real file.\n\nSaved edit.\n');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Saved edit.');
    await first.stop();
    // Swap the saved state for another doc's while its record still names this file's hash.
    const { readdirSync } = await import('node:fs');
    const live = path.join(space.dorkHome, 'docs', 'live');
    const other = new Y.Doc();
    other.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('Somebody else entirely.')]);
    for (const name of readdirSync(live).filter(
      (n) => n.endsWith('.ystate') || n.endsWith('.yfile')
    )) {
      writeFileSync(path.join(live, name), Y.encodeStateAsUpdate(other));
    }

    const restarted = start();
    const back = await TestEditor.join(restarted, await restarted.resolve(ref(rel)));
    await expect.poll(() => back.markdown(), { timeout: 5000 }).toContain('Saved edit.');
    expect(await back.markdown()).not.toContain('Somebody else entirely.');
  });
});
