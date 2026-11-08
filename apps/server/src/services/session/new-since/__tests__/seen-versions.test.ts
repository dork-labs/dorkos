import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SeenVersions } from '../seen-versions.js';
import type { AgentReleaseNote } from '../../../runtimes/shared/awareness/agent-release-notes.js';

const notes: AgentReleaseNote[] = Array.from({ length: 10 }, (_, i) => ({
  version: '0.2.0',
  name: `Feature ${i}`,
  can: 'read new facts.',
  covers: [],
  areas: [],
  gate: 'information only',
}));
let home: string;
const stores: SeenVersions[] = [];
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'new-since-'));
});
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.flush()));
  await rm(home, { recursive: true, force: true });
});
function store(version = '0.2.0', dev = false): SeenVersions {
  const result = new SeenVersions(home, { version, dev, notes });
  stores.push(result);
  return result;
}
async function seed(value: unknown): Promise<void> {
  await mkdir(path.join(home, 'state'), { recursive: true });
  await writeFile(path.join(home, 'state/agent-seen-versions.json'), JSON.stringify(value));
}
async function disk(): Promise<unknown> {
  return JSON.parse(await readFile(path.join(home, 'state/agent-seen-versions.json'), 'utf8'));
}

describe('seen versions', () => {
  it('silently establishes a baseline and retains it across a server restart', async () => {
    const first = store('0.1.0');
    expect(first.takeNewSince('ana')).toBeNull();
    await first.flush();
    const upgraded = store();
    const claim = upgraded.takeNewSince('ana')!;
    expect(claim.data).toMatchObject({
      previousVersion: '0.1.0',
      currentVersion: '0.2.0',
      omitted: 2,
    });
    expect(claim.data.lines).toHaveLength(8);
    expect(upgraded.takeNewSince('ana')).toBeNull();
    await upgraded.flush();
    expect(store().takeNewSince('ana')).toBeNull();
  });

  it('claims once across sessions, restores once, and rejects an old receipt', async () => {
    await seed({ ana: '0.1.0' });
    const versions = store();
    const first = versions.takeNewSince('ana')!;
    expect(versions.takeNewSince('ana')).toBeNull();
    versions.restoreNewSince(first);
    const second = versions.takeNewSince('ana')!;
    versions.restoreNewSince(first);
    expect(versions.takeNewSince('ana')).toBeNull();
    versions.delivered(second);
    versions.restoreNewSince(second);
    expect(versions.takeNewSince('ana')).toBeNull();
    await versions.flush();
    expect(await disk()).toEqual({ ana: '0.2.0' });
  });

  it('persists restores and all agents even with several queued writes', async () => {
    await seed({ ana: '0.1.0', bo: '0.1.0' });
    const versions = store();
    const claim = versions.takeNewSince('ana')!;
    versions.takeNewSince('bo');
    versions.restoreNewSince(claim);
    await versions.flush();
    expect(await disk()).toEqual({ ana: '0.1.0', bo: '0.2.0' });
    expect(store().takeNewSince('ana')).not.toBeNull();
  });

  it('leaves a downgrade unchanged and advances even when no notes apply', async () => {
    await seed({ ana: '0.3.0', bo: '0.1.0' });
    const versions = store('0.1.1');
    expect(versions.takeNewSince('ana')).toBeNull();
    expect(versions.takeNewSince('bo')).toBeNull();
    await versions.flush();
    expect(await disk()).toEqual({ ana: '0.3.0', bo: '0.1.1' });
  });

  it('does nothing in development, including leaving the state file untouched', async () => {
    await seed({ ana: '0.1.0' });
    expect(store('0.2.0', true).takeNewSince('ana')).toBeNull();
    expect(await disk()).toEqual({ ana: '0.1.0' });
  });

  it('discards invalid state entries without delivering a surprise note', async () => {
    await seed({ ana: 'invalid', bo: 123, cy: '0.1.0' });
    const versions = store();
    expect(versions.takeNewSince('ana')).toBeNull();
    expect(versions.takeNewSince('bo')).toBeNull();
    expect(versions.takeNewSince('cy')).not.toBeNull();
    await versions.flush();
    expect(await disk()).toEqual({ ana: '0.2.0', bo: '0.2.0', cy: '0.2.0' });
  });
});
