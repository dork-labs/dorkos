/**
 * The subagent invariant, guarded on the import graph — the second of its two halves.
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
 * subagent path re-enters session creation. So the risk guarded here is not a
 * bug that exists; it is the "resolve per tool call" convenience somebody adds
 * later, which would silently split one task across two trees.
 *
 * ## Why two tests and not one
 *
 * The behavioral half lives in
 * `routes/__tests__/sessions-cwd-resolution.test.ts` ("a turn containing a
 * subagent resolves the directory exactly once"): it drives a real turn with a
 * Task-tool sidechain through the route and counts resolver calls. That is the
 * invariant stated the way spec §3.4 states it, and it catches a second
 * resolution on the paths a turn actually walks.
 *
 * It cannot catch a second resolution on a path that turn did not walk — a tool
 * handler nobody's fixture exercises, a runtime adapter reached only by another
 * SDK. So this file guards the IMPORT GRAPH as well: the resolver may be reached
 * from the boundaries that START a turn, and from nowhere inside one. A new call
 * site fails here the moment it is written, whether or not a fixture reaches it.
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
 *   session;
 * - the room trigger dispatcher — a message in a room starting an agent's turn.
 *
 * Adding a file here is a deliberate act. Adding one that runs INSIDE a turn —
 * a tool handler, a runtime adapter, a transcript reader — breaks the invariant
 * this suite exists for, and this list is where that argument has to be made.
 *
 * **The room dispatcher is the fourth, added for DOR-1597, and the argument is
 * this.** A room turn BEGINS there: `runOneInDispatch` is the moment a room
 * message becomes an agent's turn, and nothing is running yet. It resolves the
 * directory once, before `buildRoomContext` — which has to be before, because
 * the context names attachment paths anchored on that directory and the runner
 * then puts the files there (DOR-1266), so a cwd decided later would describe
 * files the model cannot open. It is the DISPATCHER rather than
 * `room-turn-runner.ts` for the same reason: by the time the runner has the
 * request, the context describing it has already been built.
 */
const ALLOWED = new Set([
  'routes/sessions.ts',
  'services/tasks/task-scheduler-service.ts',
  'services/relay/binding-router.ts',
  'services/rooms/room-trigger.ts',
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

/**
 * Every specifier that reaches the chain, and therefore every one this guard
 * has to watch.
 *
 * `room-session-cwd.js` is the second because it CALLS the resolver: it fills in
 * the room a bare session id is bound to and hands the request straight on
 * (DOR-1624). Watching only the resolver's own specifier would have made it a
 * laundering path — anything inside a turn could reach the chain through it and
 * read as an allowed importer, because the one allowed importer of the resolver
 * would be the wrapper itself.
 */
const RESOLVER_SPECIFIERS = ['resolve-session-cwd.js', 'room-session-cwd.js'];

/**
 * The two modules that ARE the chain, and may of course name themselves.
 *
 * Nothing else is exempt — not their sibling modules, and emphatically not the
 * workspace barrel `index.ts`. Skipping the whole directory (as this test first
 * did) left a hole big enough to walk the invariant through: a `export * from
 * './resolve-session-cwd.js'` in the barrel would make the resolver reachable
 * as `services/workspace/index.js` from anywhere in the server, and every
 * importer would read as an allowed one.
 */
const CHAIN_ITSELF = new Set([
  'services/workspace/resolve-session-cwd.ts',
  'services/workspace/room-session-cwd.ts',
]);

/**
 * The file with its type-only imports removed.
 *
 * A `import type { … }` line is erased at build and cannot call anything, so it
 * is not a call site and this guard is about call sites. It is what lets the
 * rooms domain declare that it implements the port
 * (`services/rooms/repo/room-worktree-cwd.ts`) without that reading as a second place
 * a turn's directory gets decided. The inline `{ type X }` form is deliberately
 * NOT stripped: it sits on a line that also imports values, and the conservative
 * answer there is to fail loudly and make the argument here.
 *
 * @param source - The file's text.
 */
function withoutTypeImports(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('import type '))
    .join('\n');
}

describe('the subagent invariant — one resolution per turn', () => {
  it('the cwd resolver is imported only where a turn BEGINS', async () => {
    const files = await sourceFiles(SERVER_SRC);
    // The guard is only worth anything if it is reading the real tree. Pinned
    // close to the real count (755 at the time of writing) rather than at a
    // token floor: a walk that silently stopped early — a renamed directory, a
    // changed `withFileTypes` shape — would still clear a floor of 100 while
    // reading almost nothing.
    expect(files.length).toBeGreaterThan(700);
    expect(files).toContain('routes/sessions.ts');
    expect(files).toContain('services/workspace/index.ts');

    const importers: string[] = [];
    for (const rel of files) {
      if (CHAIN_ITSELF.has(rel)) continue;
      const source = withoutTypeImports(await readFile(path.join(SERVER_SRC, rel), 'utf-8'));
      if (RESOLVER_SPECIFIERS.some((specifier) => source.includes(specifier))) importers.push(rel);
    }

    expect(new Set(importers)).toEqual(ALLOWED);
  });
});
