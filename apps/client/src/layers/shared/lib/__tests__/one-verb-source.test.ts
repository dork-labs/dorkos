/**
 * One verb source for the whole cockpit (BC-37, design-decisions §5, §14.4).
 *
 * The sidebar, the session switcher and the chat status strip all describe the
 * same turn. When they each reached for their own phrasing they disagreed: the
 * strip picked a randomized joke verb while the row said nothing, and a person
 * watching both surfaces saw two different agents. DOR-1053 deleted the joke
 * pool; this file is what stops the next one.
 *
 * The failure mode is why this is a SOURCE scan rather than a behaviour test. A
 * second verb table does not throw, does not fail a type check and does not
 * change a rendered string anywhere the first table is used — it is invisible
 * until two surfaces are on screen together. Only the sources show it.
 *
 * @module shared/lib/__tests__/one-verb-source
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** `apps/client/src/layers` — everything the client is built from. */
const LAYERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Every `.ts`/`.tsx` file under `layers/`, as repo-relative POSIX paths. */
function layerSources(): { path: string; source: string }[] {
  const found: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry)) continue;
      found.push({
        path: relative(LAYERS_DIR, full).split(sep).join('/'),
        source: readFileSync(full, 'utf8'),
      });
    }
  };
  walk(LAYERS_DIR);
  return found;
}

const SOURCES = layerSources();

/**
 * The files allowed to name the tool-phrasing rung: where it is defined, the
 * ladder that is its one caller, that definition's own test, and this file.
 * Everything else must go through `activityVerb`.
 */
const MAY_NAME_THE_RUNG = new Set([
  'shared/lib/tool-labels.ts',
  'shared/lib/activity-verb.ts',
  'shared/lib/__tests__/tool-labels.test.ts',
  // This file. It holds sample module statements as executable proof that the
  // detectors below work, and that text is indistinguishable from the real
  // thing on purpose.
  'shared/lib/__tests__/one-verb-source.test.ts',
]);

/**
 * The files allowed to reach the `tool-labels` module AT ALL.
 *
 * The barrel is here and nowhere else: it legitimately re-exports `getToolLabel`
 * and friends, which are ordinary tool-naming helpers with nothing to do with
 * the ladder. It is still held to {@link MAY_NAME_THE_RUNG} and to the
 * namespace rule, so it may pass those neighbours through and never the rung.
 */
const MAY_REACH_TOOL_LABELS = new Set([...MAY_NAME_THE_RUNG, 'shared/lib/index.ts']);

/**
 * One `import`/`export … from '…'` statement; group 2 is the module specifier.
 *
 * `export` as well as `import`, because a re-export is an importable path like
 * any other — a one-name `export { formatActivityLabel } from './tool-labels';`
 * in the barrel walked straight past the first version of this file, and that
 * is exactly how prettier formats a re-export somebody adds back.
 *
 * Bounded by `[^;]*?` so a match can never run from one statement's keyword
 * past a later mention of the rung and on to some third statement's `from` —
 * which is what a lazy `[\s\S]*?` did on the first draft, making this file
 * accuse itself of what its own prose warns about.
 */
const MODULE_STATEMENT = /(^|\n)\s*(?:import|export)\b([^;]*?)\bfrom\s+['"]([^'"]+)['"]/g;

/**
 * A dynamic `import('…')`, which has no `from` keyword at all.
 *
 * The third escape shape, and the last one: `const { formatActivityLabel } =
 * await import('…/tool-labels')` is invisible to {@link MODULE_STATEMENT}
 * because that regex is anchored on `from`. It resolves to the whole module
 * namespace, so it is treated exactly as `import * as` is — whoever holds it
 * holds the rung, whether or not they type its name.
 */
const DYNAMIC_IMPORT = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * The two names that ARE the rung, either of which is a second verb source once
 * it is reachable outside {@link MAY_NAME_THE_RUNG}.
 *
 * `activityClause` joined `formatActivityLabel` when a room's lane started
 * saying "Kai is reading standup.md": the clause is the shared rung and the
 * label is one framing of it, so a file that reaches either has the table.
 */
const RUNG_NAMES = ['formatActivityLabel', 'activityClause'] as const;

/**
 * The rung name that may not travel by ANY route, not even the barrel.
 *
 * `formatActivityLabel` is the session's finished sentence and has exactly one
 * caller, so naming it in any module statement anywhere is an escape.
 * `activityClause` is deliberately different: the room lane imports it from the
 * barrel by design, and what it may never do is come from `tool-labels`
 * directly — which the rule above and {@link MAY_REACH_TOOL_LABELS} together
 * enforce, including for the barrel itself.
 */
const PRIVATE_RUNG = 'formatActivityLabel';

/** Whether a specifier points at the `tool-labels` module, by any route. */
function isToolLabels(specifier: string): boolean {
  return /(^|[./])tool-labels(\.[jt]sx?)?$/.test(specifier);
}

/**
 * Every module statement in a source, as `{ clause, specifier, namespace }`.
 *
 * `namespace` is the escape hatch that matters most and is the easiest to miss:
 * `import * as toolLabels from '…/tool-labels'` names nothing, so a
 * detector that greps for the identifier sees a clean file while
 * `toolLabels.formatActivityLabel(...)` sits three lines below it. A namespace
 * import defeated a guard on a sibling branch the same day this one was
 * written, which is why the rule below is about the MODULE rather than about
 * the name.
 */
function moduleStatements(source: string): { clause: string; specifier: string; ns: boolean }[] {
  return [
    ...[...source.matchAll(MODULE_STATEMENT)].map((match) => ({
      clause: match[2] ?? '',
      specifier: match[3] ?? '',
      ns: (match[2] ?? '').includes('*'),
    })),
    // A dynamic import is a namespace grab with extra steps.
    ...[...source.matchAll(DYNAMIC_IMPORT)].map((match) => ({
      clause: '',
      specifier: match[1] ?? '',
      ns: true,
    })),
  ];
}

/** Why this file is an offender, or `null` when it is not one. */
function ladderEscape(path: string, source: string): string | null {
  for (const { clause, specifier, ns } of moduleStatements(source)) {
    if (clause.includes(PRIVATE_RUNG) && !MAY_NAME_THE_RUNG.has(path)) {
      return `names the rung in a module statement for '${specifier}'`;
    }
    if (!isToolLabels(specifier)) continue;
    // A rung name taken STRAIGHT off `tool-labels`. Caught separately from the
    // reachability rule below because the barrel is allowed to reach that
    // module — it passes `getToolLabel` and friends through — and this is what
    // stops it passing a rung through with them.
    const named = RUNG_NAMES.filter((name) => clause.includes(name));
    if (named.length > 0 && !MAY_NAME_THE_RUNG.has(path)) {
      return `takes ${named.join(' and ')} straight from '${specifier}'`;
    }
    if (ns && !MAY_NAME_THE_RUNG.has(path)) {
      return `takes '${specifier}' wholesale as a namespace, which hands it the rung`;
    }
    if (!MAY_REACH_TOOL_LABELS.has(path)) {
      return `reaches '${specifier}' directly instead of going through activityVerb`;
    }
  }
  return null;
}

describe('the honesty ladder is the only verb source (BC-37)', () => {
  it('reads the client sources at all — a scan that matches nothing proves nothing', () => {
    // Every assertion below is only as strong as this one. If the walk breaks
    // or the layout moves, the checks would pass by finding nothing to check.
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some((file) => file.path === 'shared/lib/activity-verb.ts')).toBe(true);
  });

  it('leaves no importable path around the ladder, in any import shape', () => {
    const offenders = SOURCES.map((file) => ({
      path: file.path,
      why: ladderEscape(file.path, file.source),
    }))
      .filter((entry) => entry.why !== null)
      .map((entry) => `${entry.path} ${entry.why}`);
    expect(
      offenders,
      'call activityVerb(lifecycle, activity) instead — one turn, one phrasing (BC-37)'
    ).toEqual([]);
  });

  it('proves the detector catches every shape that has actually escaped one', () => {
    // Red-before evidence, kept executable. Each of these is a real escape:
    // the first is what the session's status strip carried until BC-37 rewired
    // it (the file is gone; `lane-state.ts` inherited the call),
    // and the other two walked past the first version of THIS file.
    const escapes = [
      // A named import of the rung, from anywhere.
      "import { formatActivityLabel } from '@/layers/shared/lib';",
      // The same, wrapped as prettier wraps it.
      'import {\n  formatActivityLabel,\n} from "../tool-labels";',
      // A one-name re-export — how prettier formats it when somebody puts the
      // rung back in the barrel. The old barrel check wanted a trailing comma
      // on its own line and never saw this.
      "export { formatActivityLabel } from './tool-labels';",
      // A namespace import, which names nothing at all and then calls
      // `toolLabels.formatActivityLabel(...)` out of sight of any grep.
      "import * as toolLabels from '@/layers/shared/lib/tool-labels';",
      // And a namespace RE-export, which puts the rung back on the barrel
      // without ever typing its name.
      "export * from './tool-labels';",
      // A dynamic import, which has no `from` keyword for a statement regex to
      // anchor on and resolves to the whole namespace anyway.
      "const { formatActivityLabel } = await import('@/layers/shared/lib/tool-labels');",
      // …including the shape that never types the name at all.
      "const mod = await import('../tool-labels');",
    ];
    for (const escape of escapes) {
      expect(
        ladderEscape('features/conversation/model/lane-state.ts', escape),
        escape
      ).not.toBeNull();
    }
    // The barrel is held to the same rule for the rung and for namespaces…
    expect(ladderEscape('shared/lib/index.ts', "export * from './tool-labels';")).not.toBeNull();
    expect(
      ladderEscape('shared/lib/index.ts', "export { formatActivityLabel } from './tool-labels';")
    ).not.toBeNull();
    // …while the neighbours it legitimately passes through stay allowed.
    expect(
      ladderEscape('shared/lib/index.ts', "export { getToolLabel } from './tool-labels';")
    ).toBeNull();
  });

  it('catches the second rung name in every shape that reaches tool-labels', () => {
    // `activityClause` is the shared rung as of DOR-1351, so the same escapes
    // that would give a file its own verb table now exist under a second name.
    // Each of these is caught for the module it names, whoever writes it.
    const escapes = [
      "import { activityClause } from '../tool-labels';",
      'import {\n  activityClause,\n} from "@/layers/shared/lib/tool-labels";',
      "export { activityClause } from './tool-labels';",
      "import * as toolLabels from '@/layers/shared/lib/tool-labels';",
      "export * from './tool-labels';",
      "const { activityClause } = await import('@/layers/shared/lib/tool-labels');",
      "const mod = await import('../tool-labels');",
    ];
    for (const escape of escapes) {
      expect(
        ladderEscape('features/conversation/model/lane-state.ts', escape),
        escape
      ).not.toBeNull();
    }
    // And the barrel, which may reach that module for its other neighbours, may
    // not pass the clause through from it — the one route the reachability rule
    // alone would let past.
    expect(
      ladderEscape('shared/lib/index.ts', "export { activityClause } from './tool-labels';")
    ).not.toBeNull();
  });

  it('leaves the room lane its intended route to the clause', () => {
    // The whole point of the refactor: `activityClause` travels OUT through
    // `activity-verb` and the barrel, and a guard that forbade that would forbid
    // the reuse it exists to protect. If this ever goes red the guard has been
    // tightened into the thing it was written to prevent.
    expect(
      ladderEscape('shared/lib/index.ts', "export { activityClause } from './activity-verb';")
    ).toBeNull();
    expect(
      ladderEscape(
        'features/conversation/model/lane-state.ts',
        "import { activityClause } from '@/layers/shared/lib';"
      )
    ).toBeNull();
  });

  it('does not fire on the many files that merely TALK about the rung', () => {
    // What makes the offender list trustworthy rather than noisy.
    expect(ladderEscape('a/b.ts', ' * see {@link formatActivityLabel} for the rung')).toBeNull();
    // Nor across two unrelated statements with a mention stranded between them,
    // which is the false positive that made the first draft fail on itself.
    expect(
      ladderEscape(
        'a/b.ts',
        'import { readFileSync } from "node:fs";\n' +
          '/** formatActivityLabel is the rung. */\n' +
          'import { activityVerb } from "../activity-verb";\n'
      )
    ).toBeNull();
    // And a namespace import of something that is not tool-labels is ordinary.
    expect(ladderEscape('a/b.ts', "import * as React from 'react';")).toBeNull();
    // As is a dynamic import of anything else — the client is full of them.
    expect(ladderEscape('a/b.ts', "const m = await import('./TopologyGraph');")).toBeNull();
  });

  it('leaves no randomized verb pool anywhere in the status strip', () => {
    // The strip is where the joke verbs lived (§14.4). A verb chosen at random
    // is a lie the moment the reading behind it is real, which it has been
    // since DOR-1053.
    const strip = SOURCES.filter((file) => file.path.startsWith('features/chat/ui/status/'));
    expect(strip.length).toBeGreaterThan(3);
    for (const file of strip) {
      expect(file.source, `${file.path} picks something at random`).not.toMatch(/Math\.random/);
    }
  });
});
