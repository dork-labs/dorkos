/**
 * The subagent invariant, as a structural guard.
 *
 * **The binding resolves exactly once per turn, at the session boundary, before
 * the runtime is invoked.** A subagent is the same agent doing the same task, so
 * it stays in the tree; a peer agent reached over Relay or Mesh is a different
 * agent, so it gets its own session, its own `agentPath` and its own binding.
 * Delegation down stays put; delegation across moves.
 *
 * That is true for free today — a claude-code subagent is an SDK sidechain
 * running inside the parent's `query` and inherits the parent process's cwd by
 * construction, and codex and opencode behave the same way. Nothing in any
 * subagent path re-enters session creation. So the risk this file guards is not
 * a bug that exists; it is the "resolve per tool call" convenience somebody adds
 * later, which would silently split one task across two trees.
 *
 * A behavioral test cannot see that coming: it would pass right up until the day
 * the new call site is added, and the assertion it would need (resolver called
 * once) is exactly what the new call site would break without any test naming
 * it. So the guard is on the IMPORT GRAPH — the resolver may be reached from the
 * boundaries that start a turn, and from nowhere inside one.
 */
import { describe, it, expect } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Every file allowed to import the resolver, as a path relative to
 * `apps/server/src`.
 *
 * Each is a place where a TURN BEGINS and no turn is yet running:
 *
 * - the session route's message-send path — a person pressing enter;
 * - the task scheduler — a cron tick starting a scheduled run;
 * - the relay binding router — an inbound chat message opening or feeding a
 *   session.
 *
 * Adding a file here is a deliberate act. Adding one that runs INSIDE a turn —
 * a tool handler, a runtime adapter, a transcript reader — breaks the invariant
 * this suite exists for, and this list is where that argument has to be made.
 */
const ALLOWED = new Set([
  'routes/sessions.ts',
  'services/tasks/task-scheduler-service.ts',
  'services/relay/binding-router.ts',
]);

/** Every `.ts` file under `apps/server/src`, relative to it, tests excluded. */
async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      found.push(...(await sourceFiles(abs)));
    } else if (entry.name.endsWith('.ts')) {
      found.push(path.relative(SERVER_SRC, abs));
    }
  }
  return found;
}

describe('the subagent invariant — one resolution per turn', () => {
  it('the cwd resolver is imported only where a turn BEGINS', async () => {
    const files = await sourceFiles(SERVER_SRC);
    // The guard is only worth anything if it is reading the real tree.
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain('routes/sessions.ts');

    const importers: string[] = [];
    for (const rel of files) {
      if (rel.startsWith('services/workspace/')) continue; // the module and its own neighbours
      const source = await readFile(path.join(SERVER_SRC, rel), 'utf-8');
      if (source.includes('resolve-session-cwd.js')) importers.push(rel);
    }

    expect(new Set(importers)).toEqual(ALLOWED);
  });
});
