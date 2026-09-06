/**
 * One drift guard for the whole `routes/` directory: no HTTP route names the
 * Activity feed's actor by hand (DOR-1829).
 *
 * ## Why one guard rather than one per router
 *
 * DOR-1801 fixed the extensions router and left a shape guard beside it that
 * enumerated `extensions*.ts`. The follow-up found the identical hardcode on four
 * more routers — agents, mesh, relay-adapters, tasks — which is the evidence that
 * a per-router guard protects the router somebody already thought about and
 * nothing else. The defect is a copy-paste, so the guard has to cover everywhere
 * the paste can land. This file replaces that block (the extensions test now
 * points here) and covers it as a strict superset, because the file list is READ
 * FROM THE DIRECTORY rather than written out: a `routes/whatever-next.ts` is
 * covered the day it is created.
 *
 * ## The two rules, and why it takes both
 *
 * 1. **No emit call site asserts its own actor.** Every `.emit({ … })` in
 *    `routes/` must spread `readActivityActor(req, res)` — the one reader that
 *    turns a request into an actor — unless it is named in {@link EXEMPT_SITES}
 *    with a reason. Checked per CALL SITE, by brace-matching the object literal,
 *    so a router that reads the caller in one route and hardcodes in the next is
 *    caught; a whole-file `source.includes(...)` would not be.
 * 2. **No file names the operator by hand, anywhere.** Rule 1 sees inside emit
 *    literals only, so a hoisted `const actor = { actorType: 'user', actorLabel:
 *    'You' }` spread in later would walk straight past it. Rule 2 is a plain
 *    unanchored line scan for that pair, which is the specific lie: a machine's
 *    write recorded as the person's own action.
 *
 * Rule 2 deliberately forbids only `user` / `'You'`, not every quoted actor
 * literal. `system` / `'System'` is a legitimate answer — DorkOS noticing
 * something nobody asked for — and a rule that banned it would be a rule people
 * route around.
 *
 * @module routes/__tests__/route-activity-actor
 */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The `routes/` directory this guard walks. */
const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The emit call sites that legitimately do NOT follow the HTTP caller, each
 * matched by a distinctive substring of its own object literal.
 *
 * An entry that matches nothing fails this test, so a site that moves or is
 * deleted cannot leave a stale licence behind; and a new emit in one of these
 * files is not covered by its neighbour's exemption.
 */
const EXEMPT_SITES: Record<string, Array<{ contains: string; reason: string }>> = {
  'mesh.ts': [
    {
      contains: "'agent.status_changed'",
      reason:
        'Nobody asked for this line. The caller sent a heartbeat; DorkOS is the one that ' +
        'noticed the health transition and is reporting it, so the actor is the system. ' +
        'Naming the heartbeat sender would say an agent changed its own status.',
    },
  ],
  'approvals.ts': [
    {
      contains: "'approval.granted'",
      reason:
        'The label comes from `resolveDecisionAuthority`, which has already refused every ' +
        'caller naming itself an agent — so it can only be a person, and `decidedBy` says ' +
        'WHICH account, which is strictly more than the header reader knows.',
    },
    {
      contains: "'approval.grant_created'",
      reason: 'Same verified decision authority as the row above.',
    },
  ],
  'relay.ts': [
    {
      contains: "'relay.message_delivered'",
      reason:
        "The actor is the MESSAGE's own `from` subject — who sent the thing that was " +
        'delivered — not whoever made the HTTP call that flushed it.',
    },
    {
      contains: "'relay.message_failed'",
      reason: 'Same message-derived actor as the row above.',
    },
  ],
};

/** Every route module, read from disk so a new one is covered on the day it lands. */
function routeFiles(): string[] {
  return readdirSync(ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every `.emit({ … })` object literal in a source file, brace-matched.
 *
 * Template holes (`${…}`) contribute a balanced pair, so a summary built from a
 * template literal does not confuse the walk.
 */
function emitCallSites(source: string): string[] {
  const sites: string[] = [];
  const needle = '.emit({';
  let from = 0;
  for (;;) {
    const at = source.indexOf(needle, from);
    if (at === -1) break;
    const open = at + needle.length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    // An unbalanced literal means the walk lost the plot — fail loudly rather
    // than silently skipping the rest of the file.
    expect(end, `unterminated emit literal at offset ${at}`).toBeGreaterThan(open);
    sites.push(source.slice(at, end + 1));
    from = end + 1;
  }
  return sites;
}

describe('no route names the Activity feed actor by hand', () => {
  it('finds the routers and their emit sites at all', () => {
    // A directory read that silently matched nothing, or a needle that stopped
    // matching after a formatting change, would pass every assertion below
    // forever. These two numbers are floors, not counts: they are here to fail
    // when the guard stops seeing the code, never when a router is added.
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(20);

    const total = files.reduce(
      (sum, file) => sum + emitCallSites(readFileSync(path.join(ROUTES_DIR, file), 'utf-8')).length,
      0
    );
    expect(total).toBeGreaterThanOrEqual(28);
  });

  it('spreads readActivityActor into every emit that follows its caller', () => {
    const unusedExemptions = new Map<string, Set<string>>(
      Object.entries(EXEMPT_SITES).map(([file, entries]) => [
        file,
        new Set(entries.map((entry) => entry.contains)),
      ])
    );

    for (const file of routeFiles()) {
      const source = readFileSync(path.join(ROUTES_DIR, file), 'utf-8');
      const exemptions = EXEMPT_SITES[file] ?? [];

      for (const site of emitCallSites(source)) {
        const exemption = exemptions.find((entry) => site.includes(entry.contains));
        if (exemption) {
          unusedExemptions.get(file)?.delete(exemption.contains);
          continue;
        }
        expect(
          site,
          `${file} writes Activity without reading the caller — spread ` +
            '`...readActivityActor(req, res)` or add a reasoned entry to EXEMPT_SITES'
        ).toContain('readActivityActor(req, res)');
      }
    }

    // A licence for a site that no longer exists is a licence somebody will
    // re-use without re-deciding.
    for (const [file, leftovers] of unusedExemptions) {
      expect(
        [...leftovers],
        `EXEMPT_SITES lists sites in ${file} that no longer exist — remove them`
      ).toEqual([]);
    }
  });

  it('leaves no route asserting that the person did it', () => {
    // Unanchored on purpose: the formatted multi-line literal is not the only
    // shape this can take, and a hoisted `const actor = { … }` spread in later is
    // exactly the shape rule 1 cannot see.
    const OPERATOR_LITERAL = /actor(Type|Label)\s*:\s*['"`](user|You)\b/;

    for (const file of routeFiles()) {
      // `approvals.ts` says `actorType: 'user'` behind a bar that has already
      // refused every non-person, and pairs it with the account that decided —
      // see EXEMPT_SITES for the full reason.
      if (file === 'approvals.ts') continue;

      const offenders = readFileSync(path.join(ROUTES_DIR, file), 'utf-8')
        .split('\n')
        .filter((line) => OPERATOR_LITERAL.test(line));
      expect(offenders, `${file} names the operator as the Activity actor by hand`).toEqual([]);
    }
  });
});
