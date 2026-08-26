/**
 * The builtin provider against the shared `MemoryProvider` conformance suite.
 *
 * **This is the gate, and it is deliberately not this package's own unit
 * tests.** `store.test.ts` and `ops.test.ts` check what this engine does;
 * `memoryConformance` checks what the PORT promises, with assertions written
 * without this implementation in view and proven able to fail against a second
 * one (`packages/test-utils/src/__tests__/memory-conformance.test.ts`). An engine
 * change that quietly stopped keeping one of the port's promises — an unreadable
 * file reported as an empty one, a cap that truncated instead of refusing, a ref
 * that read another agent's notes — goes red here rather than shipping.
 *
 * Every case runs against a REAL memory file in a real temporary directory. The
 * engine resolves its own path from the ref, so a mocked filesystem would let
 * the scope rule pass by agreeing with itself.
 *
 * @vitest-environment node
 */
import { afterAll } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryConformance, type UnreadableMemory } from '@dorkos/test-utils/memory-conformance';
import type { AgentMemoryRef } from '@dorkos/shared/memory-provider';
import { MEMORY_MAX_CHARS } from '../constants.js';
import { createBuiltinMemoryProvider } from '../builtin-provider.js';

/** Every directory this file made, removed once at the end. */
const scopes: string[] = [];

/**
 * A fresh agent directory, which for this engine IS a fresh memory scope: the
 * provider resolves `<agentPath>/.dork/MEMORY.md` and nothing else.
 */
async function makeRef(): Promise<AgentMemoryRef> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'dorkos-memory-conformance-'));
  scopes.push(dir);
  return { agentId: path.basename(dir), agentPath: dir };
}

/**
 * An agent whose memory cannot be read, arranged the only way a filesystem
 * offers without depending on permissions (which root ignores): put a DIRECTORY
 * where the file goes, so the read fails with `EISDIR` rather than `ENOENT`.
 *
 * The distinction is the whole point of the case — `ENOENT` is "confirmed
 * nothing", and anything else is "I could not tell".
 */
async function makeUnreadableMemory(): Promise<UnreadableMemory> {
  const ref = await makeRef();
  await mkdir(path.join(ref.agentPath, '.dork', 'MEMORY.md'), { recursive: true });
  return { provider: createBuiltinMemoryProvider(), ref };
}

afterAll(async () => {
  await Promise.all(scopes.map((dir) => rm(dir, { recursive: true, force: true })));
});

memoryConformance(createBuiltinMemoryProvider, {
  name: 'builtin MemoryProvider — conformance',
  capChars: MEMORY_MAX_CHARS,
  makeRef,
  makeUnreadableMemory,
});
