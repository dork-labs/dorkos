/**
 * Every event the server broadcasts on the global stream must be on the client's
 * allowlist, or nobody ever sees it.
 *
 * ## The defect this exists for
 *
 * `StreamManager` does not forward whatever arrives. It attaches one listener per
 * name in `GENERIC_EVENTS` and drops everything else on the floor — silently, with
 * no warning in the console and no failing request. So a server that starts
 * emitting a new event and a client that was never told about it produce exactly
 * the same symptom as a feature that was never built: nothing happens. This has
 * bitten this repo before, and it is expensive precisely because it looks like a
 * bug in the feature rather than a missing line in a list.
 *
 * A type cannot catch it. The two ends are in different apps, the fan-out takes a
 * plain string, and `GENERIC_EVENTS` is a client-side constant the server never
 * imports. Nothing connects them except this file.
 *
 * ## What it checks, and what it cannot
 *
 * A textual scan, in the manner of `capabilities/__tests__/gate-bypass-scan.ts`.
 * It sees `eventFanOut.broadcast('name', …)` — a literal name, spelled inline —
 * and nothing else. Two broadcasts are deliberately invisible to it and are
 * neither bugs nor exceptions:
 *
 * - A name built from a variable (`relay-sse-events`' signal type, the session
 *   list's own discriminant). Those names come from typed unions the client
 *   already handles as a set.
 * - `ext:<id>:<event>`, which is per-extension and cannot be enumerated ahead of
 *   time; extensions subscribe by name through their own API.
 *
 * So this is a floor, not a fence: it catches the honest case of somebody adding
 * a broadcast, which is the case that has actually happened.
 *
 * @module services/core/__tests__/sse-event-allowlist
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** `apps/server/src`, resolved from this file rather than from the cwd. */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The client module that owns the allowlist. */
const STREAM_MANAGER = path.resolve(
  SERVER_SRC,
  '../../client/src/layers/shared/lib/transport/stream-manager.ts'
);

/**
 * Names the client subscribes to without the server broadcasting them by literal.
 *
 * Each needs a reason, because an entry here is a name this scan stops protecting.
 */
const NOT_BROADCAST_BY_LITERAL: Record<string, string> = {
  connected: 'written directly into the SSE response when a client attaches, not fanned out',
  relay_backpressure: "built from the relay signal's own type, which is a typed union",
  relay_signal: "built from the relay signal's own type, which is a typed union",
};

/** Every `.ts` file under a directory, excluding tests and declaration files. */
async function productionSources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      files.push(...(await productionSources(full)));
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Strip comments, so a name mentioned in prose is not read as a call.
 *
 * Line comments go FIRST, and that order is load-bearing rather than tidy. A `//`
 * line that mentions a block-comment opener — `apps/server/src/index.ts` has one,
 * reading "`/*` regardless of `config.auth.enabled`" — opens a block comment that
 * the next `*&#47;` anywhere in the file closes. Stripping blocks first ate 71,000
 * characters of that file, including four live broadcasts, and the scan came back
 * green over the wreckage. Removing the line comments first leaves nothing for the
 * block pass to mis-pair.
 */
function code(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every literal event name broadcast on the global fan-out. */
async function broadcastNames(): Promise<string[]> {
  const found = new Set<string>();
  for (const file of await productionSources(SERVER_SRC)) {
    const pattern = /\.broadcast\(\s*['"]([A-Za-z0-9_]+)['"]/g;
    for (const match of code(await readFile(file, 'utf-8')).matchAll(pattern)) {
      found.add(match[1]);
    }
  }
  return [...found].sort();
}

/** The names in the client's `GENERIC_EVENTS` array, read from its source. */
async function allowlist(): Promise<string[]> {
  const source = await readFile(STREAM_MANAGER, 'utf-8');
  const block = /export const GENERIC_EVENTS = \[([\s\S]*?)\] as const;/.exec(source);
  if (!block) throw new Error(`Could not find GENERIC_EVENTS in ${STREAM_MANAGER}`);
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
}

// Both sides are read ONCE, at module load, rather than per case. Walking the
// whole server tree three times inside a 5s case budget is enough I/O to time
// itself out on a loaded machine, and every case wants the same two answers.
const BROADCAST = await broadcastNames();
const ALLOWED = await allowlist();

describe('the client allowlist covers every event the server broadcasts', () => {
  it('found both sides to compare', () => {
    // Two vacuity guards. A scan that matched nothing, or an allowlist that parsed
    // as empty, would make every assertion below trivially true — which is the one
    // way this test could stop working without saying so.
    expect(BROADCAST.length).toBeGreaterThan(5);
    expect(ALLOWED.length).toBeGreaterThan(5);
  });

  it('every broadcast name is one the client dispatches', () => {
    const missing = BROADCAST.filter((name) => !ALLOWED.includes(name));
    expect(
      missing,
      missing.length
        ? `\n${missing.join('\n')}\n\n` +
            `The server broadcasts these on /api/events and the client's GENERIC_EVENTS does ` +
            `not list them, so StreamManager attaches no listener and they are dropped without ` +
            `a trace.\n\n` +
            `Add each name to GENERIC_EVENTS in ` +
            `apps/client/src/layers/shared/lib/transport/stream-manager.ts.`
        : ''
    ).toEqual([]);
  });

  it('every allowlisted name is one the server actually broadcasts', () => {
    // The reverse direction, so the list cannot rot into names nothing emits. An
    // entry that is real but built from a variable belongs in
    // NOT_BROADCAST_BY_LITERAL with its reason, not deleted.
    const stale = ALLOWED.filter(
      (name) => !BROADCAST.includes(name) && !(name in NOT_BROADCAST_BY_LITERAL)
    );
    expect(
      stale,
      stale.length
        ? `\n${stale.join('\n')}\n\nGENERIC_EVENTS lists these and no server module broadcasts ` +
            `them by name. Either the emitter was removed (delete the entry) or the name is ` +
            `built from a variable (add it to NOT_BROADCAST_BY_LITERAL with the reason).`
        : ''
    ).toEqual([]);
  });
});
