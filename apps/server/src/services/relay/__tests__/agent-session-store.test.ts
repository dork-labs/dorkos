import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentSessionStore } from '../agent-session-store.js';

describe('AgentSessionStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'agent-session-store-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A store over `dir`, initialized. */
  async function open(): Promise<AgentSessionStore> {
    const store = new AgentSessionStore(dir);
    await store.init();
    return store;
  }

  it('keeps set, updated and deleted mappings across a restart, and the first createdAt', async () => {
    const store = await open();
    store.set('agent-a', 'sdk-a-v1');
    store.set('agent-b', 'sdk-b');
    await store.shutdown();
    const createdAt = JSON.parse(await readFile(path.join(dir, 'agent-sessions.json'), 'utf-8'))[
      'agent-a'
    ].createdAt;
    store.set('agent-a', 'sdk-a-v2');
    store.delete('agent-b');
    await store.shutdown();

    const restarted = await open();
    expect(restarted.get('agent-a')).toBe('sdk-a-v2');
    expect(restarted.get('agent-b')).toBeUndefined();
    const saved = JSON.parse(await readFile(path.join(dir, 'agent-sessions.json'), 'utf-8'));
    expect(saved['agent-a'].createdAt).toBe(createdAt);
  });

  it('starts empty on a missing or corrupt file', async () => {
    expect((await open()).get('any')).toBeUndefined();
    await writeFile(path.join(dir, 'agent-sessions.json'), 'not-valid-json');
    expect((await open()).get('any')).toBeUndefined();
  });

  it('never throws when a save fails, and keeps the mapping in memory', async () => {
    // A relay dir under a regular file cannot be written to.
    await writeFile(path.join(dir, 'blocker'), '');
    const store = new AgentSessionStore(path.join(dir, 'blocker', 'relay'));
    await store.init();
    expect(() => store.set('agent-e', 'sdk-e')).not.toThrow();
    expect(() => store.delete('nobody')).not.toThrow();
    await store.shutdown();
    expect(store.get('agent-e')).toBe('sdk-e');
  });
});
