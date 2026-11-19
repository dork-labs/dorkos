/** The write record path trust reads (DOR-4528): each changed file traced, by content, to its author. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  contentOf,
  isInsideAnExtensionsFolder,
  markTrusted,
  noteWriteDone,
  noteWriteFailed,
  noteWriteStarting,
  resetPathTrustWriters,
  tiedToAuthor,
} from '../path-trust-writers.js';

let root: string;
let home: string;
let folder: string;
let call = 0;

/** Write a file the way a noted file tool does: noted, written as asked, completed. */
async function toolWrite(
  rel: string,
  text: string,
  over: { held?: boolean; agentHome?: string; actually?: string } = {}
): Promise<void> {
  const file = path.join(folder, rel);
  const id = `call-${++call}`;
  await noteWriteStarting(
    id,
    { file, agentHome: over.agentHome ?? home, held: over.held ?? false },
    () => Buffer.from(text)
  );
  await fs.writeFile(file, over.actually ?? text);
  await noteWriteDone(id);
}

/** The content of every file in the copy now. */
async function filesNow(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of await fs.readdir(folder)) out[name] = await contentOf(path.join(folder, name));
  return out;
}

/** Whether the change from `trusted` to the files now is the author's. */
const check = async (trusted: Record<string, string>) =>
  tiedToAuthor({ id: 'desk', folder, authorHome: home, trusted, next: await filesNow() });

describe('path-trust writers', () => {
  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pt-writers-')));
    home = path.join(root, 'ana');
    folder = path.join(home, '.dork', 'extensions', 'desk');
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(path.join(folder, 'server.ts'), 'v1');
  });
  afterEach(async () => {
    resetPathTrustWriters();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('keeps only writes aimed inside an extensions folder', async () => {
    expect(isInsideAnExtensionsFolder(path.join(folder, 'server.ts'))).toBe(true);
    expect(isInsideAnExtensionsFolder(path.join(home, '.dork', 'agent.json'))).toBe(false);
    expect(isInsideAnExtensionsFolder(path.join(home, 'extensions', 'desk', 'a.ts'))).toBe(false);
  });

  it('a chain of the author’s writes from the trusted content is the author’s', async () => {
    const trusted = await filesNow();
    await toolWrite('server.ts', 'v2');
    await toolWrite('server.ts', 'v3');
    await toolWrite('new.ts', 'n');
    expect(await check(trusted)).toBe(true);
  });

  it('a change the hooks never saw is no one’s', async () => {
    const trusted = await filesNow();
    await fs.writeFile(path.join(folder, 'server.ts'), 'v2');
    expect(await check(trusted)).toBe(false);
  });

  it('one clean write does not vouch for an unseen change to another file', async () => {
    await fs.writeFile(path.join(folder, 'index.ts'), 'i1');
    const trusted = await filesNow();
    await toolWrite('index.ts', 'i2');
    await fs.writeFile(path.join(folder, 'server.ts'), 'payload');
    expect(await check(trusted)).toBe(false);
  });

  it('an unseen change to the same file after the author’s write breaks the chain', async () => {
    const trusted = await filesNow();
    await toolWrite('server.ts', 'v2');
    await fs.appendFile(path.join(folder, 'server.ts'), 'payload');
    expect(await check(trusted)).toBe(false);
  });

  it('a write that left other bytes than it was asked to vouches for nothing', async () => {
    const trusted = await filesNow();
    await toolWrite('server.ts', 'v2', { actually: 'v2 and more' });
    expect(await check(trusted)).toBe(false);
  });

  it('a held turn’s write is not the author’s', async () => {
    const trusted = await filesNow();
    await toolWrite('server.ts', 'v2', { held: true });
    expect(await check(trusted)).toBe(false);
  });

  it('another agent’s write is not the author’s', async () => {
    const trusted = await filesNow();
    await toolWrite('server.ts', 'v2', { agentHome: path.join(root, 'bo') });
    expect(await check(trusted)).toBe(false);
  });

  it('a removed file is no one’s', async () => {
    await fs.writeFile(path.join(folder, 'extra.ts'), 'x');
    const trusted = await filesNow();
    await fs.rm(path.join(folder, 'extra.ts'));
    expect(await check(trusted)).toBe(false);
  });

  it('a write that failed is not kept', async () => {
    const trusted = await filesNow();
    await noteWriteStarting(
      'failed',
      { file: path.join(folder, 'server.ts'), agentHome: home, held: false },
      () => Buffer.from('v2')
    );
    noteWriteFailed('failed');
    await noteWriteDone('failed');
    await fs.writeFile(path.join(folder, 'server.ts'), 'v2');
    expect(await check(trusted)).toBe(false);
  });

  it('writes from before the files were last trusted do not vouch for a later change', async () => {
    await toolWrite('server.ts', 'v2');
    markTrusted('desk');
    const trusted = await filesNow();
    await fs.writeFile(path.join(folder, 'server.ts'), 'v3');
    expect(await check(trusted)).toBe(false);
  });

  it('a record that overflowed since the files were trusted cannot answer', async () => {
    const trusted = await filesNow();
    const other = path.join(home, '.dork', 'extensions', 'other');
    await fs.mkdir(other, { recursive: true });
    for (let i = 0; i <= 5_000; i += 1) {
      const id = `o-${i}`;
      await noteWriteStarting(
        id,
        { file: path.join(other, 'f.ts'), agentHome: home, held: false },
        () => Buffer.from('')
      );
      await noteWriteDone(id);
    }
    await toolWrite('server.ts', 'v2');
    expect(await check(trusted)).toBe(false);
  });
});
