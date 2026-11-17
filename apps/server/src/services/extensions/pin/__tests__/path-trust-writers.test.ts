/** The write record path trust reads (DOR-4528): what it keeps, and when it cannot answer. */
import { afterEach, describe, expect, it } from 'vitest';
import {
  editedByAuthor,
  isInsideAnExtensionsFolder,
  noteExtensionWrite,
  resetPathTrustWriters,
} from '../path-trust-writers.js';

const HOME = '/agents/ana';
const COPY = { id: 'desk', realPath: `${HOME}/.dork/extensions/desk` };
const write = (file = `${COPY.realPath}/server.ts`) =>
  noteExtensionWrite({ file, agentHome: HOME, held: false });

describe('path-trust writers', () => {
  afterEach(() => resetPathTrustWriters());

  it('keeps only writes aimed inside an extensions folder', () => {
    expect(isInsideAnExtensionsFolder(`${COPY.realPath}/server.ts`)).toBe(true);
    expect(isInsideAnExtensionsFolder(`${HOME}/.dork/agent.json`)).toBe(false);
    expect(isInsideAnExtensionsFolder(`${HOME}/extensions/desk/server.ts`)).toBe(false);
    write(`${HOME}/notes.md`);
    expect(editedByAuthor(COPY, HOME)).toBe(false);
  });

  it('each ask starts the next window, so one write vouches for one edit', () => {
    write();
    expect(editedByAuthor(COPY, HOME)).toBe(true);
    expect(editedByAuthor(COPY, HOME)).toBe(false);
  });

  it('a copy with no real path is tied to no one', () => {
    write();
    expect(editedByAuthor({ id: 'desk' }, HOME)).toBe(false);
  });

  it('a write from a turn that runs as no agent is tied to no one', () => {
    noteExtensionWrite({ file: `${COPY.realPath}/server.ts`, agentHome: undefined, held: false });
    expect(editedByAuthor(COPY, HOME)).toBe(false);
  });

  it('a record that overflowed inside the window cannot answer', () => {
    for (let i = 0; i <= 5_000; i += 1) write(`${HOME}/.dork/extensions/other/f${i}.ts`);
    write();
    expect(editedByAuthor(COPY, HOME)).toBe(false);
  });
});
