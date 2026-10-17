/**
 * Live docs end to end, on the real markdown worker and the installation's real
 * file writer (DOR-2984): agent writes never clobber a person's unsaved edits,
 * a closed doc is written as a file, and every write outside an editor keeps
 * the doc's previous bytes as a version that can be restored.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DocChangedError, DocNotReadError, type DocCollabService } from '../doc-collab-service.js';
import { LiveDoc } from '../live-doc.js';
import type { DocVersionStore } from '../doc-versions.js';
import {
  liveDocDeps,
  makeService,
  makeSpace,
  TestEditor,
  type TestSpace,
} from './collab-harness.js';

const AGENT = { kind: 'agent' as const, name: 'Ada' };

let space: TestSpace;
let service: DocCollabService;
let versions: DocVersionStore;

beforeEach(async () => {
  space = await makeSpace();
  ({ service, versions } = makeService(space));
});

afterEach(async () => {
  await service.stop();
  space.cleanup();
});

function ref(rel: string) {
  return { cwd: space.space, path: rel };
}

function onDisk(rel: string): string {
  return readFileSync(path.join(space.space, rel), 'utf8');
}

describe('an open doc', () => {
  it('keeps a person’s unsaved typing when an agent writes from a stale read', async () => {
    const rel = space.write('plan.md', '# Plan\n\nFirst idea.\n\nSecond idea.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    expect(await person.markdown()).toContain('First idea.');

    // The agent reads, then the person types before the agent writes back.
    await service.read(ref(rel), { writer: AGENT, sessionKey: 's1' });
    await person.type('# Plan\n\nFirst idea.\n\nSecond idea.\n\nThe person typed this.\n');
    await service.write(
      ref(rel),
      '# Plan\n\nFirst idea, sharpened by the agent.\n\nSecond idea.\n',
      {
        writer: AGENT,
        sessionKey: 's1',
      }
    );

    const shown = await person.markdown();
    expect(shown).toContain('First idea, sharpened by the agent.');
    expect(shown).toContain('The person typed this.');
    expect(person.notes).toContainEqual({ type: 'changed', changedBy: AGENT });
  });

  it('refuses a write from an agent that never read the open doc, and changes nothing', async () => {
    const rel = space.write('notes.md', 'One.\n\nTwo.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await person.type('One.\n\nTwo.\n\nPerson’s three.\n');

    await expect(
      service.write(ref(rel), 'One, by the agent.\n\nTwo.\n', { writer: AGENT })
    ).rejects.toBeInstanceOf(DocNotReadError);

    const shown = await person.markdown();
    expect(shown).not.toContain('One, by the agent.');
    expect(shown).toContain('Person’s three.');
  });

  it('merges an agent that read the file before anybody opened it', async () => {
    const rel = space.write('early.md', 'One.\n\nTwo.\n');
    await service.read(ref(rel), { writer: AGENT, sessionKey: 'early' });
    const person = await TestEditor.join(service, await service.resolve(ref(rel)));
    await person.type('One.\n\nTwo.\n\nPerson’s three.\n');
    await service.write(ref(rel), 'One, by the agent.\n\nTwo.\n', {
      writer: AGENT,
      sessionKey: 'early',
    });
    const shown = await person.markdown();
    expect(shown).toContain('One, by the agent.');
    expect(shown).toContain('Person’s three.');
  });

  it('writes the merged doc to its file through the shared writer', async () => {
    const rel = space.write('flush.md', 'Start.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await person.type('Start.\n\nTyped.\n');
    await expect.poll(() => onDisk(rel), { timeout: 3000 }).toContain('Typed.');
  });

  it('refuses a base read from another doc', async () => {
    const a = space.write('a.md', 'Doc A.\n');
    const b = space.write('b.md', 'Doc B.\n');
    const deps = liveDocDeps(space);
    const docA = await LiveDoc.open(await service.resolve(ref(a)), deps);
    const docB = await LiveDoc.open(await service.resolve(ref(b)), deps);
    try {
      const readOfA = await docA.read();
      const failure = await docB
        .write('Doc B, clobbered.\n', AGENT, readOfA.base)
        .catch((err: unknown) => err);
      expect(failure).toMatchObject({ code: 'BASE_MISMATCH' });
      expect((await docB.read()).markdown).toContain('Doc B.');
    } finally {
      await docA.close();
      await docB.close();
      await deps.worker.close();
    }
  });

  it('merges a change made on disk, keeping the person’s typing', async () => {
    await service.stop();
    ({ service, versions } = makeService(space, { watch: true }));
    const rel = space.write('disk.md', 'Alpha.\n\nBeta.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await person.type('Alpha.\n\nBeta.\n\nGamma from the person.\n');
    // Before the editor's typing reaches the file, an agent's own Write tool
    // rewrites the file from what it read.
    writeFileSync(path.join(space.space, rel), 'Alpha, rewritten on disk.\n\nBeta.\n');

    await expect
      .poll(() => person.markdown(), { timeout: 5000 })
      .toContain('Alpha, rewritten on disk.');
    expect(await person.markdown()).toContain('Gamma from the person.');
    await expect.poll(() => onDisk(rel), { timeout: 5000 }).toContain('Gamma from the person.');
    expect(onDisk(rel)).toContain('Alpha, rewritten on disk.');
  });
});

describe('a closed doc', () => {
  it('writes an agent’s write straight to the file, keeping the old bytes', async () => {
    const rel = space.write('closed.md', '# Old\n');
    await service.read(ref(rel), { writer: AGENT, sessionKey: 's1' });
    await service.write(ref(rel), '# New\n', { writer: AGENT, sessionKey: 's1' });
    expect(onDisk(rel)).toBe('# New\n');
    const doc = await service.resolve(ref(rel));
    const [kept] = await versions.list(doc.scope);
    expect(kept?.changedBy).toEqual(AGENT);
    expect(await versions.read(doc.scope, kept!.id)).toBe('# Old\n');
  });

  it('refuses a write from a read the file has moved past', async () => {
    const rel = space.write('stale.md', 'v1\n');
    await service.read(ref(rel), { writer: AGENT, sessionKey: 's1' });
    writeFileSync(path.join(space.space, rel), 'v2 by someone else\n');
    await expect(
      service.write(ref(rel), 'v1, edited\n', { writer: AGENT, sessionKey: 's1' })
    ).rejects.toBeInstanceOf(DocChangedError);
    expect(onDisk(rel)).toBe('v2 by someone else\n');
  });

  it('writes the last edits when the last editor leaves', async () => {
    await service.stop();
    ({ service, versions } = makeService(space, { flushDelayMs: 60_000, flushMaxWaitMs: 60_000 }));
    const rel = space.write('leave.md', 'Before.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await person.type('Before.\n\nAfter.\n');
    person.leave();
    await expect.poll(() => onDisk(rel), { timeout: 3000 }).toContain('After.');
    // Dropped: the next write goes straight to the file.
    await expect
      .poll(async () => (await service.read(ref(rel), { writer: AGENT })).live, { timeout: 3000 })
      .toBe(false);
  });
});

describe('restoring a previous version', () => {
  it('undoes an agent’s write while nobody has the doc open, and can be undone itself', async () => {
    const rel = space.write('restore.md', 'Mine.\n');
    await service.read(ref(rel), { writer: AGENT, sessionKey: 's1' });
    await service.write(ref(rel), 'The agent’s.\n', { writer: AGENT, sessionKey: 's1' });
    const doc = await service.resolve(ref(rel));
    const [before] = await versions.list(doc.scope);

    const result = await service.restore(ref(rel), before!.id, { kind: 'person' });
    expect(result.live).toBe(false);
    expect(onDisk(rel)).toBe('Mine.\n');
    const [undo] = await versions.list(doc.scope);
    expect(await versions.read(doc.scope, undo!.id)).toBe('The agent’s.\n');
  });

  it('reaches the people editing, live', async () => {
    const rel = space.write('live-restore.md', 'Original.\n');
    const doc = await service.resolve(ref(rel));
    const person = await TestEditor.join(service, doc);
    await service.read(ref(rel), { writer: AGENT, sessionKey: 's1' });
    await service.write(ref(rel), 'Agent rewrote everything.\n', {
      writer: AGENT,
      sessionKey: 's1',
    });
    expect(await person.markdown()).toContain('Agent rewrote everything.');
    const [before] = await versions.list(doc.scope);

    const result = await service.restore(ref(rel), before!.id, { kind: 'person' });
    expect(result.live).toBe(true);
    expect(await person.markdown()).toContain('Original.');
    expect(await person.markdown()).not.toContain('Agent rewrote');
  });

  it('refuses a version that does not exist', async () => {
    const rel = space.write('none.md', 'x\n');
    await expect(
      service.restore(ref(rel), '01JZZZZZZZZZZZZZZZZZZZZZZZ', { kind: 'person' })
    ).rejects.toMatchObject({ status: 404 });
  });
});
