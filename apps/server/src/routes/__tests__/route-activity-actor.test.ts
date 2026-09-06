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
 * 2. **No file names an actor by hand, anywhere.** Rule 1 sees inside emit
 *    literals only, so a hoisted `const actor = { actorType: 'user', actorLabel:
 *    'You' }` spread in later would walk straight past it. Rule 2 is a plain
 *    unanchored line scan over the whole file, so it catches the hoisted shape
 *    wherever it hides.
 *
 * ## Rule 2 is an allowlist, not a blocklist
 *
 * It first forbade only `user` / `'You'` — the exact lie in the bug report — and
 * that was too narrow in a way review caught: `actorType: 'agent', actorLabel:
 * 'Definitely Not You'`, sitting beside a perfectly good `readActivityActor`
 * spread, passed all three assertions. Naming a specific WRONG answer only ever
 * bans the wrong answer somebody already thought of.
 *
 * So the alphabet is inverted. **Every quoted `actorType` / `actorLabel` /
 * `actorId` literal is forbidden**, with exactly one legal pair carved out:
 * `actorType: 'system'` and `actorLabel: 'System'`. That pair is a real answer —
 * DorkOS reporting something nobody asked for, like a health transition — and
 * banning it would make this a rule people route around. The carve-out is applied
 * by STRIPPING those two literals from the line before testing it, so
 * `actorType: 'system', actorLabel: 'Definitely Not You'` on one line still reds:
 * a legal half must not launder an illegal one.
 *
 * The sites in {@link EXEMPT_SITES} are redacted from the source before rule 2
 * scans it, rather than their whole FILE being skipped. `approvals.ts` writes
 * `actorType: 'user'` in two reasoned places; skipping the file for that reason
 * would also license a hoisted operator const anywhere else in it, which is the
 * hole rule 2 exists to close.
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

/** Any quoted value assigned to an actor field — the shape rule 2 forbids. */
const ACTOR_LITERAL = /actor(Type|Label|Id)\s*:\s*['"`]/;

/** `actorType: 'system'`, the one actor type a route may state outright. */
const LEGAL_SYSTEM_TYPE = /actorType\s*:\s*(['"`])system\1/g;

/** `actorLabel: 'System'`, its label half. */
const LEGAL_SYSTEM_LABEL = /actorLabel\s*:\s*(['"`])System\1/g;

/**
 * Whether one line of source names an Activity actor by hand.
 *
 * Written as an allowlist: the legal `system` pair is STRIPPED and whatever
 * quoted actor literal survives is an offence. Testing for a legal literal
 * instead would let `actorType: 'system', actorLabel: 'Definitely Not You'` pass
 * on the strength of its innocent half.
 *
 * @param line - One line of a route module.
 * @returns True when the line states an actor rather than reading one.
 */
function namesAnActorByHand(line: string): boolean {
  const withoutLegalPair = line.replace(LEGAL_SYSTEM_TYPE, '').replace(LEGAL_SYSTEM_LABEL, '');
  return ACTOR_LITERAL.test(withoutLegalPair);
}

/**
 * The source with every {@link EXEMPT_SITES} emit literal blanked out.
 *
 * Rule 2 scans this rather than the raw file, so an exemption licenses the SITE
 * it names and not the whole module around it. `approvals.ts` is the case that
 * makes the difference: two of its emits legitimately say `actorType: 'user'`,
 * and skipping the file for them would also license a hoisted operator const
 * anywhere else in it.
 */
function withoutExemptSites(file: string, source: string): string {
  const exemptions = EXEMPT_SITES[file] ?? [];
  if (exemptions.length === 0) return source;

  let redacted = source;
  for (const site of emitCallSites(source)) {
    if (exemptions.some((entry) => site.includes(entry.contains))) {
      // A string pattern replaces the first occurrence, and the sites in a file
      // are distinct text, so each is blanked exactly once.
      redacted = redacted.replace(site, '/* exempt emit site — see EXEMPT_SITES */');
    }
  }
  return redacted;
}

describe('no route names the Activity feed actor by hand', () => {
  it('finds the routers and their emit sites at all', () => {
    // A directory read that silently matched nothing, or a needle that stopped
    // matching after a formatting change, would pass every assertion below
    // forever. These two numbers are floors, not counts: they are here to fail
    // when the guard stops seeing the code, never when a router is added.
    const files = routeFiles();
    expect(files.length).toBeGreaterThan(20);

    // 28 is the count on the day this landed. It is a floor, so ADDING an emit
    // never touches it — but DELETING a legitimate one eventually will, and that
    // red is the point: lower it deliberately, having checked the finder still
    // works, rather than letting the guard quietly go blind.
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

  it('leaves no route asserting an actor by hand', () => {
    for (const file of routeFiles()) {
      const source = withoutExemptSites(file, readFileSync(path.join(ROUTES_DIR, file), 'utf-8'));
      const offenders = source.split('\n').filter((line) => namesAnActorByHand(line));

      expect(
        offenders,
        `${file} names an Activity actor by hand — read the caller with ` +
          "`readActivityActor(req, res)`; only `system` / 'System' may be stated outright"
      ).toEqual([]);
    }
  });

  // The plant an adversarial review used to break the first version of rule 2,
  // kept as an executable check on the rule rather than on the routers: a wrong
  // actor that is not the operator is still a wrong actor.
  it('rule 2 catches a hand-named actor that is not the operator', () => {
    expect(namesAnActorByHand("          actorLabel: 'Definitely Not You',")).toBe(true);
    expect(namesAnActorByHand("          actorType: 'agent',")).toBe(true);
    expect(namesAnActorByHand("      actorId: 'some/agent/path',")).toBe(true);
    expect(namesAnActorByHand("    actorType: 'user',")).toBe(true);
    expect(namesAnActorByHand('    actorLabel: `You`,')).toBe(true);

    // The one legal pair, together and apart.
    expect(namesAnActorByHand("          actorType: 'system',")).toBe(false);
    expect(namesAnActorByHand("          actorLabel: 'System',")).toBe(false);
    expect(namesAnActorByHand("  actorType: 'system', actorLabel: 'System',")).toBe(false);

    // A legal half must not launder an illegal one on the same line.
    expect(namesAnActorByHand("  actorType: 'system', actorLabel: 'Definitely Not You',")).toBe(
      true
    );

    // Derived actors — the shape every fixed route now uses — are untouched.
    expect(namesAnActorByHand('          ...readActivityActor(req, res),')).toBe(false);
    expect(namesAnActorByHand('      actorLabel: authority.decidedBy,')).toBe(false);
    expect(namesAnActorByHand('      actorType,')).toBe(false);
  });
});
