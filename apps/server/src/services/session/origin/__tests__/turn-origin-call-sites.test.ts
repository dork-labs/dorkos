/**
 * Every place in the server that BINDS a session, and what it says it is
 * (DOR-2105).
 *
 * The type system already refuses a call that names no origin. What it cannot
 * refuse is a call that names the WRONG one — `{ kind: 'interactive' }` on a
 * scheduled run compiles perfectly and quietly gives a timer-fired turn the
 * power level a person configured for themselves. So the census is written
 * down here, one row per call site, and a new one fails this file until
 * somebody adds it with the origin they meant.
 *
 * It reads the source rather than the runtime on purpose: several of these
 * call sites only fire behind a live relay, a live scheduler or a
 * `DORKOS_TEST_RUNTIME` server, and a census that could only see the ones a
 * unit test happens to reach would be a census of the easy ones.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/server/src`, the tree the census covers. */
const SRC = fileURLToPath(new URL('../../../..', import.meta.url));

/**
 * The census: source path (relative to `apps/server/src`) → the origin kinds
 * that file may pass.
 *
 * An array because one file may legitimately bind more than one kind of thing;
 * today none does, and a second entry appearing in one of these lists is worth
 * reading twice.
 */
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  // A person posted a message and is holding the session's event stream open.
  'routes/sessions.ts': ['interactive'],
  // A room turn, carrying the one fact that decides its power.
  'services/rooms/room-turn-runner.ts': ['room'],
  // A task's run — the timer's, or a person's "Run now".
  'services/tasks/task-scheduler-service.ts': ['schedule'],
  // One agent addressed another over the relay.
  'services/relay/adapter-factory.ts': ['agent-dm'],
  // A chat binding created a session for an inbound message.
  'services/relay/binding-subsystem.ts': ['relay-binding'],
  // A connector event woke an agent up.
  'services/connectors/events/session-target.ts': ['connector-event'],
  // The in-process end-to-end harness, behind `DORKOS_TEST_RUNTIME`.
  'index.ts': ['test-harness'],
};

/**
 * Where the method is DECLARED rather than called — the registry itself, and
 * the narrow port the connector-event target asks its host through. Neither
 * passes an origin, and neither is a turn-starting surface.
 */
const DECLARATIONS = new Set([
  'services/core/runtime-registry.ts',
  'services/connectors/events/session-target.ts',
]);

/** Every `.ts` file under `apps/server/src` that is not a test. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

/**
 * The origin kinds a file passes, read off the text immediately after each
 * call. A declaration-only occurrence contributes nothing.
 */
function originsPassedIn(source: string, isDeclaration: boolean): string[] {
  const kinds: string[] = [];
  for (const match of source.matchAll(/persistSessionRuntime\(/g)) {
    const window = source.slice(match.index, match.index + 400);
    const kind = /\bkind: '([a-z-]+)'/.exec(window);
    // A declaration file's own signature has no `kind:` after it, which is
    // exactly how it is told apart from a call.
    if (kind) kinds.push(kind[1]);
    else if (!isDeclaration) kinds.push('<none>');
  }
  return kinds;
}

describe('every session-binding call site declares what it is', () => {
  const found: Record<string, string[]> = {};
  for (const file of sourceFiles(SRC)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('persistSessionRuntime(')) continue;
    const rel = relative(SRC, file);
    const kinds = originsPassedIn(source, DECLARATIONS.has(rel));
    if (kinds.length > 0) found[rel] = [...new Set(kinds)].sort();
  }

  it('finds exactly the call sites the census names', () => {
    // A new turn-starting surface reddens here. Add it to EXPECTED with the
    // origin you meant — and if that origin is a new union member, the
    // mapping's own `never` check will already have made you decide its power.
    expect(Object.keys(found).sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(Object.entries(EXPECTED))('%s passes %o', (file, kinds) => {
    expect(found[file]).toEqual([...kinds].sort());
  });
});
