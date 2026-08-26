/**
 * The REGISTRY FACADE against the shared `MemoryProvider` conformance suite.
 *
 * `getMemoryProvider()` returns a `MemoryProvider`, and it is the one every
 * caller in this server actually holds — the injection path, the `memory_write`
 * handler, everything. So it is an implementation of the port like any other,
 * and until now it was the only implementation the gate did not cover: the
 * engine was conformant and the facade in front of it was taken on trust.
 *
 * That gap had a bug in it. `getSnapshot` promises never to throw, and the
 * facade's first version rethrew refusal-typed errors, so a backend that
 * carefully wrapped its disk failure in `MemoryIOError` produced a rejection on
 * the way INTO a turn. The suite's "never THROWS for a read that failed" case is
 * the standing guard against that whole class, which is why this file exists
 * rather than a single regression test.
 *
 * **What this run cannot reach, and where it lives instead.** Everything here
 * runs with `builtin` behind the facade, so the fallback, the bench and the
 * one-warning rule are not exercised — those need a backend that misbehaves on
 * purpose, and they are in `registry.test.ts` next door. What this run proves is
 * that the facade is a faithful `MemoryProvider`: the argument validation it
 * added does not reject a legitimate call, refusals reach the caller unchanged,
 * scope is not flattened, and a failed read is reported rather than raised.
 *
 * @vitest-environment node
 */
import { beforeEach, afterAll, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MEMORY_MAX_CHARS } from '@dorkos/shared/convention-files';
import {
  BUILTIN_MEMORY_PROVIDER_ID,
  MemoryIOError,
  type AgentMemoryRef,
} from '@dorkos/shared/memory-provider';
import { createBuiltinMemoryProvider } from '@dorkos/memory';
import { memoryConformance, type UnreadableMemory } from '@dorkos/test-utils/memory-conformance';

vi.mock('../../core/config-manager.js', () => ({
  configManager: { getDot: () => BUILTIN_MEMORY_PROVIDER_ID },
}));

import { getMemoryProvider, registerMemoryProvider, resetMemoryProvider } from '../registry.js';

/** Every directory this file made, removed once at the end. */
const scopes: string[] = [];

/** A fresh agent directory, which is a fresh memory scope for the builtin engine. */
async function makeRef(): Promise<AgentMemoryRef> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorkos-facade-conformance-'));
  scopes.push(dir);
  return { agentId: path.basename(dir), agentPath: dir };
}

/**
 * A scope whose read fails **by raising**, which is the arrangement that makes
 * these two cases a real guard rather than a repeat.
 *
 * The engine's own run arranges an unreadable memory on the filesystem (a
 * directory where the file goes) and the engine REPORTS it — so pointing this
 * hook at the same trick would test the engine again and leave the facade's own
 * behaviour uncovered. What is specific to the facade is what it does with a
 * backend that THROWS on a read, and the sharpest version is a throw the
 * registry classifies as a refusal: a fault would merely fall back, while a
 * refusal is the case that used to escape as a rejected promise on the way into
 * a turn.
 *
 * Registering over `builtin` is contained rather than sloppy: the top-level
 * `beforeEach` resets the registry before every case, and this hook runs inside
 * the case that uses it.
 */
async function makeUnreadableMemory(): Promise<UnreadableMemory> {
  const ref = await makeRef();
  await mkdir(path.join(ref.agentPath, '.dork'), { recursive: true });
  registerMemoryProvider(BUILTIN_MEMORY_PROVIDER_ID, () => ({
    ...createBuiltinMemoryProvider(),
    getSnapshot: () => Promise.reject(new MemoryIOError('read', new Error('the disk is busy'))),
  }));
  return { provider: getMemoryProvider(), ref };
}

beforeEach(() => {
  resetMemoryProvider();
});

afterAll(async () => {
  await Promise.all(scopes.map((dir) => rm(dir, { recursive: true, force: true })));
});

memoryConformance(getMemoryProvider, {
  name: 'the memory registry facade — conformance',
  capChars: MEMORY_MAX_CHARS,
  makeRef,
  makeUnreadableMemory,
});
