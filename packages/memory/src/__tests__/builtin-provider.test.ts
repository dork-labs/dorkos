import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { MemoryUnsupportedError } from '@dorkos/shared/memory-provider';

import { BUILTIN_MEMORY_PROVIDER_ID, createBuiltinMemoryProvider } from '../builtin-provider.js';

let root: string;
let agentPath: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'dorkos-memory-provider-'));
  agentPath = path.join(root, 'agents', 'alpha');
  await mkdir(agentPath, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('the builtin memory provider', () => {
  const provider = createBuiltinMemoryProvider();

  it('declares who it is and what it cannot do', () => {
    expect(provider.info).toEqual({
      id: BUILTIN_MEMORY_PROVIDER_ID,
      capabilities: { search: false, consolidate: false },
    });
  });

  it('reads and writes one agent through the port', async () => {
    await provider.write(
      { agentId: 'alpha', agentPath },
      {
        action: 'add',
        text: 'deploys go out on Tuesdays',
        provenance: { room: null, date: '2026-08-24' },
      }
    );

    const snapshot = await provider.getSnapshot({ agentId: 'alpha', agentPath });

    expect(snapshot.status).toBe('present');
    expect(snapshot.content).toContain(
      '- deploys go out on Tuesdays (noted in a direct chat, 2026-08-24)'
    );
  });

  it('REFUSES a query rather than answering "found nothing"', async () => {
    // The two are the same sentence to a model unless one of them is an error,
    // and "found nothing" is also the answer a working search gives for a fact
    // the agent really did record.
    await expect(
      provider.query({ agentId: 'alpha', agentPath }, { text: 'deploys' })
    ).rejects.toBeInstanceOf(MemoryUnsupportedError);
  });

  it('REFUSES to consolidate rather than quietly doing nothing', async () => {
    // A silent no-op would let a caller believe the file had been tidied.
    await expect(provider.consolidate({ agentId: 'alpha', agentPath })).rejects.toBeInstanceOf(
      MemoryUnsupportedError
    );
  });

  it('names the capability and the method in its refusal', async () => {
    await expect(provider.query({ agentId: 'alpha', agentPath }, { text: 'x' })).rejects.toThrow(
      /'query' is not supported by memory provider 'builtin'/
    );
  });

  it('forgets through the port', async () => {
    const ref = { agentId: 'alpha', agentPath };
    await provider.write(ref, { action: 'add', text: 'one' });
    await provider.write(ref, { action: 'add', text: 'two' });

    await provider.forget(ref, { text: '- one' });

    const snapshot = await provider.getSnapshot(ref);
    expect(snapshot.content).not.toContain('- one');
    expect(snapshot.content).toContain('- two');
  });
});
