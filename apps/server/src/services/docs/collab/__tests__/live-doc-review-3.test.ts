/**
 * Live docs, third review (DOR-2984): a change on disk is never half-taken
 * (the file base moves only once the doc has the change), the file base
 * never holds what the doc lacks, unsaved edits that only delete are still
 * unsaved, and a saved state that cannot be trusted still gives up its
 * unsaved text as a version.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';
import type { DocCollabService } from '../doc-collab-service.js';
import { DocVersionStore } from '../doc-versions.js';
import { makeService, makeSpace, TestEditor, type TestSpace } from './collab-harness.js';

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
const versionsDir = () => path.join(space.dorkHome, 'docs', 'versions');

/** A version store whose next `keep` fails, as a full disk would. */
class FlakyVersions extends DocVersionStore {
  failures = 0;
  override async keep(...args: Parameters<DocVersionStore['keep']>) {
    if (this.failures > 0) {
      this.failures -= 1;
      throw new Error('ENOSPC: no space left on device');
    }
    return super.keep(...args);
  }
}

describe('a change on disk whose version cannot be kept', () => {
  it('is not lost: it is taken in once the version can be kept, before the next save', async () => {
    const versions = new FlakyVersions(versionsDir());
    const service = start({ watch: true, versions, flushDelayMs: 300, flushMaxWaitMs: 300 });
    const rel = space.write('kept.md', 'Alpha.\n\nBeta.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await expect.poll(() => person.markdown()).toContain('Beta.');
    await person.type('Alpha.\n\nBeta.\n\nTyped.\n');
    versions.failures = 1;
    writeFileSync(path.join(space.space, rel), 'Alpha, from disk.\n\nBeta.\n');

    await expect.poll(() => onDisk(rel), { timeout: 6000 }).toContain('Typed.');
    expect(onDisk(rel)).toContain('Alpha, from disk.');
    // File-watcher waits of up to 6 s: the budget fits them.
  }, 15_000);
});

describe('a change on disk to a block the person deleted', () => {
  it('leaves later changes on disk mergeable', async () => {
    const service = start({ watch: true, flushDelayMs: 60_000, flushMaxWaitMs: 60_000 });
    const rel = space.write('deleted-block.md', 'One.\n\nTwo.\n\nThree.\n');
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await expect.poll(() => person.markdown()).toContain('Two.');
    await person.type('One.\n\nThree.\n');

    // An agent edits the block the person deleted: the edit has nowhere to go.
    writeFileSync(path.join(space.space, rel), 'One.\n\nTwo, edited.\n\nThree.\n');
    await new Promise((resolve) => setTimeout(resolve, 500));
    writeFileSync(path.join(space.space, rel), 'One, edited later.\n\nTwo, edited.\n\nThree.\n');

    await expect.poll(() => person.markdown(), { timeout: 5000 }).toContain('One, edited later.');
    expect(await person.markdown()).not.toContain('Two');
    // File-watcher waits of up to 6 s: the budget fits them.
  }, 15_000);
});

describe('unsaved edits that only delete', () => {
  it('are written to the file after a restart', async () => {
    const first = start({ flushDelayMs: 60_000, flushMaxWaitMs: 60_000, persistDelayMs: 20 });
    const rel = space.write('delete-only.md', 'Keep.\n\nRemove me.\n');
    const person = await TestEditor.join(first, await first.resolve(ref(rel)));
    await expect.poll(() => person.markdown()).toContain('Remove me.');
    await person.type('Keep.\n');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(onDisk(rel)).toContain('Remove me.');

    const restarted = start();
    await TestEditor.join(restarted, await restarted.resolve(ref(rel)));
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).not.toContain('Remove me.');
  });
});

describe('a saved state that cannot be trusted', () => {
  it('still keeps its unsaved text as a version', async () => {
    const first = start({ flushDelayMs: 60_000, flushMaxWaitMs: 60_000, persistDelayMs: 20 });
    const rel = space.write('untrusted.md', 'On disk.\n');
    const doc = await first.resolve(ref(rel));
    const person = await TestEditor.join(first, doc);
    await person.type('On disk.\n\nTyped, never saved.\n');
    await new Promise((resolve) => setTimeout(resolve, 200));
    // The file's own state is damaged; the whole state is fine.
    const live = path.join(space.dorkHome, 'docs', 'live');
    const other = new Y.Doc();
    other.getXmlFragment('prosemirror').insert(0, [new Y.XmlText('Somebody else.')]);
    for (const name of readdirSync(live).filter((n) => n.endsWith('.yfile'))) {
      writeFileSync(path.join(live, name), Y.encodeStateAsUpdate(other));
    }

    const restarted = start();
    await TestEditor.join(restarted, await restarted.resolve(ref(rel)));
    const versions = new DocVersionStore(versionsDir());
    await expect
      .poll(async () => (await versions.list(doc.scope)).map((v) => v.reason), { timeout: 5000 })
      .toContain('unsaved-edits');
    const draft = (await versions.list(doc.scope)).find((v) => v.reason === 'unsaved-edits')!;
    expect(await versions.read(doc.scope, draft.id)).toContain('Typed, never saved.');
  });
});
