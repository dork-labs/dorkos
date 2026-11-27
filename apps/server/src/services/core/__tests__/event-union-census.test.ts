/**
 * Every broadcast on the global stream names a member of the one event union
 * (`@dorkos/shared/dorkos-events`, ADR 261123-170833), and every member of the
 * union is something the server sends.
 *
 * The fan-out's `broadcast` already takes `DorkOsEventType`, so a typo fails the
 * typecheck. This census is the reader's half: it lists every call site, so a
 * name built from a variable is seen and explained rather than trusted, and it
 * catches a union member nothing sends any more. The client derives its list
 * from the union (`generic-events.ts`), so a name missing from the union would
 * be dropped there without a trace.
 *
 * It reads the raw source, comments included, for the reasons the old
 * allowlist scan gave: stripping comments without a tokenizer silently hid real
 * calls twice in this repo, while reading prose costs at most one extra entry.
 *
 * @module services/core/__tests__/event-union-census
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DORKOS_EVENT_NAMES,
  dorkOsEventArea,
  isDorkOsEventType,
} from '@dorkos/shared/dorkos-events';

/** `apps/server/src`, resolved from this file rather than from the cwd. */
const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Call sites whose event name is an expression, by `file: expression`. Each is
 * typed against the union, so the typecheck holds them; the reason says which
 * members they can be.
 */
const NAMED_BY_EXPRESSION: Record<string, string> = {
  'services/session/catalog/session-list-broadcaster.ts: outgoing.type':
    "a SessionListEvent's own type: session_upserted, session_removed or session_status",
  'startup/steps/relay-routes.ts: eventType': 'relay_backpressure or relay_signal',
};

/** Union members no call site sends by a literal name, and why. */
const NOT_SENT_BY_LITERAL: Record<string, string> = {
  connected: 'the connect preamble, written to one reader (global-events-connect.ts)',
  heartbeat: 'the SSE keepalive, written by the route itself',
  session_upserted: 'outgoing.type in session-list-broadcaster.ts',
  session_removed: 'outgoing.type in session-list-broadcaster.ts',
  session_status: 'outgoing.type in session-list-broadcaster.ts',
  relay_backpressure: 'eventType in relay-routes.ts',
  relay_signal: 'eventType in relay-routes.ts',
};

/** One `eventFanOut.broadcast(` or `.broadcastRedacted(` call and its first argument. */
interface CallSite {
  readonly file: string;
  readonly firstArgument: string;
}

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

/** Every broadcast call site, with its first argument as written. */
async function callSites(): Promise<CallSite[]> {
  const sites: CallSite[] = [];
  const pattern = /eventFanOut\.broadcast(?:Redacted)?\(\s*([^,]+?)\s*,/g;
  for (const file of await productionSources(SERVER_SRC)) {
    const rel = path.relative(SERVER_SRC, file).split(path.sep).join('/');
    for (const match of (await readFile(file, 'utf-8')).matchAll(pattern)) {
      sites.push({ file: rel, firstArgument: match[1]! });
    }
  }
  return sites;
}

/** The literal name a first argument spells, or `undefined` for an expression. */
function literalName(argument: string): string | undefined {
  return /^'([^']+)'$/.exec(argument)?.[1] ?? /^"([^"]+)"$/.exec(argument)?.[1];
}

const SITES = await callSites();

describe('every broadcast on the global stream names a member of the event union', () => {
  it('found the call sites', () => {
    // A scan that matched nothing would make every case below trivially green.
    expect(SITES.length).toBeGreaterThanOrEqual(55);
  });

  it('every literal name is a member of the union', () => {
    const outside = SITES.filter((site) => {
      const name = literalName(site.firstArgument);
      return name !== undefined && !isDorkOsEventType(name);
    }).map((site) => `${site.file}: ${site.firstArgument}`);
    expect(outside, 'add each to a table in packages/shared/src/dorkos-events.ts').toEqual([]);
  });

  it('every other name is the extension family or a listed, typed expression', () => {
    const unexplained = SITES.filter((site) => literalName(site.firstArgument) === undefined)
      .filter((site) => !/^`ext:\$\{[^}]+\}:\$\{[^}]+\}`$/.test(site.firstArgument))
      .map((site) => `${site.file}: ${site.firstArgument}`)
      .filter((key) => !(key in NAMED_BY_EXPRESSION));
    expect(unexplained, 'list each in NAMED_BY_EXPRESSION with its members').toEqual([]);
  });

  it('every listed expression still exists', () => {
    const keys = new Set(SITES.map((site) => `${site.file}: ${site.firstArgument}`));
    expect(Object.keys(NAMED_BY_EXPRESSION).filter((key) => !keys.has(key))).toEqual([]);
  });

  it('every member of the union is sent by some call site', () => {
    const sent = new Set(SITES.map((site) => literalName(site.firstArgument)));
    const unsent = DORKOS_EVENT_NAMES.filter(
      (name) => !sent.has(name) && !(name in NOT_SENT_BY_LITERAL)
    );
    expect(unsent, 'remove the member, or say in NOT_SENT_BY_LITERAL who sends it').toEqual([]);
  });

  it('every NOT_SENT_BY_LITERAL entry is a member nothing sends by a literal name', () => {
    const sent = new Set(SITES.map((site) => literalName(site.firstArgument)));
    const stale = Object.keys(NOT_SENT_BY_LITERAL).filter(
      (name) => !isDorkOsEventType(name) || sent.has(name)
    );
    expect(stale, 'remove each from NOT_SENT_BY_LITERAL').toEqual([]);
  });

  it('every member names its area, and a null area says why', () => {
    for (const name of DORKOS_EVENT_NAMES) {
      const { area, areaNote } = dorkOsEventArea(name);
      expect(area !== null || (areaNote ?? '').length > 0, name).toBe(true);
    }
    expect(dorkOsEventArea('ext:my-app:changed').area).toBe('extensions');
    expect(isDorkOsEventType('ext:my-app:changed')).toBe(true);
    expect(isDorkOsEventType('ext:no-event')).toBe(false);
    expect(isDorkOsEventType('not_an_event')).toBe(false);
  });
});
