/**
 * The agent doc tools (DOR-2984): refused plainly while Docs are off, a write
 * from this session's read merges with a person's typing, and a closed doc's
 * read-then-write is a plain file write that refuses a stale read.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const flags = vi.hoisted(() => ({ docs: true }));
vi.mock('../../../../core/config-manager.js', () => ({
  configManager: {
    get: vi.fn((key: string) => (key === 'docs' ? { enabled: flags.docs } : undefined)),
    set: vi.fn(),
  },
}));

import { createDocReadHandler, createDocWriteHandler, getDocTools } from '../doc-tools.js';
import type { McpToolDeps } from '../types.js';
import { InstallationFileWrites } from '../../../../canvas/doc-channel/writes/installation-file-writes.js';
import { getDocCollab, initDocCollab, stopDocCollab } from '../../../../docs/collab/index.js';
import {
  makeSpace,
  TestEditor,
  type TestSpace,
} from '../../../../docs/collab/__tests__/collab-harness.js';

let space: TestSpace;
let deps: McpToolDeps;

beforeEach(async () => {
  flags.docs = true;
  space = await makeSpace();
  deps = { defaultCwd: space.space } as McpToolDeps;
  initDocCollab({ dorkHome: space.dorkHome, writer: new InstallationFileWrites() });
});

afterEach(async () => {
  await stopDocCollab();
  space.cleanup();
});

const session = () => ({ sessionKey: 'session-1', agentName: async () => 'Ada' });

function parse(result: { content: { text: string }[]; isError?: boolean }) {
  return { ...JSON.parse(result.content[0]!.text), isError: result.isError === true };
}

describe('doc tools', () => {
  it('are named doc_read and doc_write', () => {
    expect(getDocTools(deps, session).map((tool) => tool.name)).toEqual(['doc_read', 'doc_write']);
  });

  it('refuse plainly while Docs are off', async () => {
    flags.docs = false;
    const rel = space.write('off.md', 'x\n');
    const read = parse(await createDocReadHandler(deps, session)({ path: rel }));
    expect(read).toMatchObject({ isError: true, error: expect.stringContaining('turned off') });
    const write = parse(await createDocWriteHandler(deps, session)({ path: rel, markdown: 'y\n' }));
    expect(write.isError).toBe(true);
    expect(readFileSync(path.join(space.space, rel), 'utf8')).toBe('x\n');
  });

  it('merge a write from this session’s read with what a person typed since', async () => {
    const rel = space.write('plan.md', 'Intro.\n\nBody.\n');
    const person = await TestEditor.join(
      getDocCollab()!,
      await getDocCollab()!.resolve({ cwd: space.space, path: rel })
    );
    const read = parse(await createDocReadHandler(deps, session)({ path: rel }));
    expect(read).toMatchObject({ live: true, markdown: expect.stringContaining('Intro.') });

    await person.type('Intro.\n\nBody.\n\nThe person’s line.\n');
    const write = parse(
      await createDocWriteHandler(
        deps,
        session
      )({ path: rel, markdown: 'Intro, by Ada.\n\nBody.\n' })
    );
    expect(write).toMatchObject({ live: true, changed: true, isError: false });
    const shown = await person.markdown();
    expect(shown).toContain('Intro, by Ada.');
    expect(shown).toContain('The person’s line.');
    expect(person.notes).toContainEqual({
      type: 'changed',
      changedBy: { kind: 'agent', name: 'Ada' },
    });
  });

  it('write a closed doc as a file, and refuse a read the file has moved past', async () => {
    const rel = space.write('closed.md', 'v1\n');
    parse(await createDocReadHandler(deps, session)({ path: rel }));
    const write = parse(
      await createDocWriteHandler(deps, session)({ path: rel, markdown: 'v2\n' })
    );
    expect(write).toMatchObject({ live: false, changed: true });
    expect(readFileSync(path.join(space.space, rel), 'utf8')).toBe('v2\n');

    writeFileSync(path.join(space.space, rel), 'v3 by someone else\n');
    const stale = parse(
      await createDocWriteHandler(deps, session)({ path: rel, markdown: 'v2, again\n' })
    );
    expect(stale).toMatchObject({ isError: true, error: expect.stringContaining('Read it again') });
    expect(readFileSync(path.join(space.space, rel), 'utf8')).toBe('v3 by someone else\n');
  });

  it('say so for a doc outside the folder boundary', async () => {
    const result = parse(
      await createDocReadHandler(deps, session)({ path: 'x.md', cwd: space.dorkHome })
    );
    expect(result.isError).toBe(true);
  });
});
