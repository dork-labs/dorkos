/**
 * The contracts that must hold for EVERY fixture — purity, provenance, zone
 * shape, and the promises that are stated as "never".
 *
 * @module features/dashboard-sidebar/model/__tests__/build-sidebar-model.contracts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSidebarModel, type SidebarRowModel } from '../build-sidebar-model';
import { SIDEBAR_FIXTURES } from '../fixtures';

const MODEL_DIR = join(__dirname, '..');
const RULES_DIR = join(MODEL_DIR, 'rules');

/**
 * A source with its comments removed, so the purity check reads the CODE.
 *
 * The docs in these modules name the very calls the rule forbids — that is how
 * the rule is written down where the next author will read it — so a check over
 * the raw text would fail on its own documentation.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

/** Every source file the purity rule covers: the entry point and its rules. */
function pureModuleSources(): { file: string; source: string }[] {
  const files = [
    join(MODEL_DIR, 'build-sidebar-model.ts'),
    join(MODEL_DIR, 'sidebar-state.ts'),
    ...readdirSync(RULES_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(RULES_DIR, name)),
  ];
  return files.map((file) => ({ file, source: stripComments(readFileSync(file, 'utf8')) }));
}

/**
 * The only modules a pure model file may import VALUES from.
 *
 * A whitelist rather than a search for bad spellings, because the bad spellings
 * are unbounded: a grep for `Date.now()` is walked straight past by
 * `import { useInteractionStore } from '@/layers/entities/interactions'`, which
 * drags in zustand, React and a clock without ever writing the words down. What
 * is bounded is the set of things these files are allowed to reach for.
 *
 * `import type` is exempt and unlisted: a type import is erased before the
 * bundle exists, so it can pull from anywhere without putting a single byte —
 * or a single side effect — into the module.
 *
 * `@/layers/entities/session` is here on purpose and with an honest caveat. The
 * model needs `partitionSessionsByOrigin`, and FSD says cross-module imports go
 * through the barrel, which re-exports React components. So "this module cannot
 * see React" is false transitively and always was; what these tests actually
 * hold is the thing that matters — no module HERE reads a clock, holds state,
 * or renders.
 */
const ALLOWED_VALUE_IMPORTS = [
  '@dorkos/shared/smart-groups',
  '@/layers/entities/session',
  // Relative siblings inside the model itself.
  /^\.{1,2}\//,
];

/** Every `import ... from '<specifier>'` in a source, with its type-only flag. */
function importsOf(source: string): { specifier: string; typeOnly: boolean }[] {
  const out: { specifier: string; typeOnly: boolean }[] = [];
  const pattern = /import\s+(type\s+)?[^'";]*?from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    out.push({ specifier: match[2] ?? '', typeOnly: match[1] !== undefined });
    match = pattern.exec(source);
  }
  return out;
}

/** Whether one specifier is on the whitelist. */
function allowedValueImport(specifier: string): boolean {
  return ALLOWED_VALUE_IMPORTS.some((entry) =>
    typeof entry === 'string' ? entry === specifier : entry.test(specifier)
  );
}

/**
 * Every use of `Date` in a source that is NOT one of the two shapes a pure
 * module may use: `new Date(<argument>)` and `Date.parse(`.
 *
 * Catches what a spelling grep does not: `new Date` with no parentheses at all
 * (valid JS, and a clock), and `const Clock = Date` followed by `Clock.now()`,
 * which never writes `Date.now` anywhere.
 */
function illegalDateUses(source: string): string[] {
  const out: string[] = [];
  const pattern = /\bDate\b(.{0,12})/gs;
  let match: RegExpExecArray | null = pattern.exec(source);
  while (match !== null) {
    const before = source.slice(Math.max(0, match.index - 4), match.index);
    const after = match[1] ?? '';
    const isConstructedWithArgument = before.endsWith('new ') && /^\(\s*[^)\s]/.test(after);
    const isParse = after.startsWith('.parse(');
    if (!isConstructedWithArgument && !isParse) out.push(`Date${after.split('\n')[0] ?? ''}`);
    match = pattern.exec(source);
  }
  return out;
}

/** Walk every node the model emits, so an assertion cannot miss a branch. */
function* walk(state: (typeof SIDEBAR_FIXTURES)[number]['state']) {
  const model = buildSidebarModel(state);
  for (const zone of model.zones) {
    yield { kind: 'zone' as const, reason: zone.reason, zone };
    for (const section of zone.sections) {
      yield { kind: 'section' as const, reason: section.reason, zone, section };
      for (const row of section.rows) {
        yield { kind: 'row' as const, reason: row.reason, zone, section, row };
      }
      for (const sub of section.subsections ?? []) {
        yield { kind: 'section' as const, reason: sub.reason, zone, section: sub };
        for (const row of sub.rows) {
          yield { kind: 'row' as const, reason: row.reason, zone, section: sub, row };
        }
      }
    }
  }
}

/** Every row a fixture produces, with the zone it came from. */
function rowsOf(state: (typeof SIDEBAR_FIXTURES)[number]['state']) {
  const out: { zoneId: string; row: SidebarRowModel }[] = [];
  for (const node of walk(state)) {
    if (node.kind === 'row') out.push({ zoneId: node.zone.id, row: node.row });
  }
  return out;
}

describe('P1 AC-1 — purity, asserted over the module source', () => {
  // A runtime spy is not enough: the offending call may sit on a branch this
  // fixture never takes. The source is the only place every branch is visible.
  it.each(pureModuleSources())('$file value-imports only whitelisted modules', ({ source }) => {
    const offenders = importsOf(source)
      .filter((entry) => !entry.typeOnly)
      .map((entry) => entry.specifier)
      .filter((specifier) => !allowedValueImport(specifier));
    expect(offenders).toEqual([]);
  });

  it.each(pureModuleSources())('$file reads no clock it was not given', ({ source }) => {
    expect(illegalDateUses(source)).toEqual([]);
    expect(source).not.toMatch(/\bperformance\b/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/\bIntl\./);
  });

  it('proves the import whitelist can fail', () => {
    const offending = stripComments(
      "import { useInteractionStore } from '@/layers/entities/interactions';\n" +
        "import type { Whatever } from '@/layers/widgets/anything';\n"
    );
    const entries = importsOf(offending);
    expect(entries).toHaveLength(2);
    // The value import is caught…
    expect(allowedValueImport('@/layers/entities/interactions')).toBe(false);
    // …and the type-only one is exempt by design, not by accident.
    expect(entries[1]?.typeOnly).toBe(true);
  });

  it('proves the clock check catches what a spelling grep does not', () => {
    // Each of these walked straight past the previous textual assertion.
    expect(illegalDateUses('const d = new Date;').length).toBeGreaterThan(0);
    expect(illegalDateUses('const Clock = Date;\nClock.now();').length).toBeGreaterThan(0);
    expect(illegalDateUses('const d = new Date();').length).toBeGreaterThan(0);
    expect(illegalDateUses('const at = Date.now();').length).toBeGreaterThan(0);
    // And that it still permits the two shapes a pure rule legitimately uses.
    expect(illegalDateUses('const d = new Date(now);')).toEqual([]);
    expect(illegalDateUses('const ms = Date.parse(iso);')).toEqual([]);
  });

  it('proves comment stripping keeps the code it is checking', () => {
    const offending = stripComments('/** Never call Date.now(). */\nconst at = Date.now();\n');
    expect(offending).toMatch(/Date\.now\(\)/);
    expect(offending).not.toMatch(/Never call/);
    for (const { source } of pureModuleSources()) {
      expect(source).toMatch(/export (function|const|type|interface)/);
    }
  });

  it('returns the same tree for the same state', () => {
    for (const { state } of SIDEBAR_FIXTURES) {
      expect(buildSidebarModel(state)).toEqual(buildSidebarModel(state));
    }
  });

  it('mutates nothing it was given', () => {
    for (const { state } of SIDEBAR_FIXTURES) {
      const before = JSON.stringify(state);
      buildSidebarModel(state);
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});

describe.each(SIDEBAR_FIXTURES)('$name fixture', ({ state }) => {
  it('P1 AC-2 — every zone, section and row carries a well-formed reason', () => {
    const nodes = [...walk(state)];
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      expect(node.reason, `${node.kind} reason`).toMatch(/^[a-z-]+:[a-z-]+$/);
    }
  });

  it('BC-1 — no empty zone, and no section with zero rows and no rollup', () => {
    for (const node of walk(state)) {
      if (node.kind === 'zone') {
        expect(node.zone.sections.length).toBeGreaterThan(0);
        const rows = node.zone.sections.flatMap((section) => [
          ...section.rows,
          ...(section.subsections ?? []).flatMap((sub) => sub.rows),
        ]);
        expect(rows.length, `zone ${node.zone.id} is empty`).toBeGreaterThan(0);
      }
      // One exception, and only one: a group the operator MADE. Everything
      // else here appears because something is in it, so an empty one is a box
      // with nothing to say — but a group that disappeared the instant it was
      // created could never be dragged into, and Library's whole promise is
      // that the structure you built stays where you put it.
      if (
        node.kind === 'section' &&
        node.section.rows.length === 0 &&
        node.section.reason !== 'library:group'
      ) {
        expect(node.section.subsections?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('BC-2 — no zone carries a collapsed field', () => {
    for (const zone of buildSidebarModel(state).zones) {
      expect(Object.keys(zone)).not.toContain('collapsed');
    }
  });

  it('BC-3 — zones come in the fixed order', () => {
    const order = ['getting-started', 'now', 'today', 'library'];
    const ids = buildSidebarModel(state).zones.map((zone) => zone.id);
    const positions = ids.map((id) => order.indexOf(id));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(ids.filter((id) => id === 'now' || id === 'getting-started').length).toBeLessThanOrEqual(
      1
    );
  });

  it('BC-5 — Now holds nothing but attention rows and the working rollup', () => {
    const now = buildSidebarModel(state).zones.find((zone) => zone.id === 'now');
    for (const row of now?.sections.flatMap((section) => section.rows) ?? []) {
      expect(['attention', 'rollup']).toContain(row.target.kind);
      expect(row.unread.tier).toBe('none');
      if (row.target.kind === 'rollup') {
        expect(['working', 'now-overflow']).toContain(row.target.rollup);
      }
    }
  });

  it('BC-8 — Now never emits more than five rows', () => {
    const now = buildSidebarModel(state).zones.find((zone) => zone.id === 'now');
    const rows = now?.sections.flatMap((section) => section.rows) ?? [];
    expect(rows.length).toBeLessThanOrEqual(5);
  });

  it('BC-21 — no session row ever appears in Now', () => {
    for (const { zoneId, row } of rowsOf(state)) {
      if (zoneId === 'now') expect(row.target.kind).not.toBe('session');
    }
  });

  it('BC-28 — one indent level: no subsection has subsections', () => {
    for (const zone of buildSidebarModel(state).zones) {
      for (const section of zone.sections) {
        for (const sub of section.subsections ?? []) {
          expect(sub.subsections).toBeUndefined();
        }
      }
    }
  });

  it('R3 — every row outside Library is undraggable', () => {
    for (const { zoneId, row } of rowsOf(state)) {
      if (zoneId !== 'library') expect(row.draggable, `${zoneId}/${row.key}`).toBe(false);
    }
  });

  it('R2 WCAG 2.5.7 — every draggable row offers a move action', () => {
    for (const { row } of rowsOf(state)) {
      if (row.draggable) expect(row.actions).toContain('move');
    }
  });

  it('row keys are unique within a section', () => {
    // Per section, not per zone: a pinned agent renders in Pins AND in Agents,
    // and the anchor renders in Today AND in Library (BC-33 — dual presence is
    // intentional). React keys only have to be unique among siblings.
    for (const zone of buildSidebarModel(state).zones) {
      const sections = zone.sections.flatMap((section) => [
        section,
        ...(section.subsections ?? []),
      ]);
      for (const section of sections) {
        const keys = section.rows.map((row) => row.key);
        expect(new Set(keys).size, `duplicate key in ${zone.id}/${section.id}`).toBe(keys.length);
      }
    }
  });

  it('carries no verb text, timestamp or countdown', () => {
    for (const { row } of rowsOf(state)) {
      const text = `${row.primary} ${row.secondary ?? ''} ${row.preview ?? ''}`;
      expect(text).not.toMatch(/\d+\s?(s|m|h|d)\s?ago/i);
      expect(text).not.toMatch(/working…|editing |running /);
    }
  });
});
