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
    ...readdirSync(RULES_DIR)
      .filter((name) => name.endsWith('.ts'))
      .map((name) => join(RULES_DIR, name)),
  ];
  return files.map((file) => ({ file, source: stripComments(readFileSync(file, 'utf8')) }));
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
  it.each(pureModuleSources())('$file imports no React', ({ source }) => {
    expect(source).not.toMatch(/from ['"]react['"]/);
  });

  it.each(pureModuleSources())('$file calls no Date.now()', ({ source }) => {
    expect(source).not.toMatch(/Date\.now\(\)/);
  });

  it.each(pureModuleSources())('$file constructs no argument-less Date', ({ source }) => {
    expect(source).not.toMatch(/new Date\(\s*\)/);
  });

  it.each(pureModuleSources())('$file reaches for no implicit-timezone Intl', ({ source }) => {
    expect(source).not.toMatch(/\bIntl\./);
  });

  it('proves the source check can fail — and that stripping keeps the code', () => {
    const offending = stripComments(
      '/** Never call Date.now(). */\nconst at = Date.now();\n// nor new Date()\nconst d = new Date();\n'
    );
    expect(offending).toMatch(/Date\.now\(\)/);
    expect(offending).toMatch(/new Date\(\s*\)/);
    expect(offending).not.toMatch(/Never call/);
    // The check would be worthless if stripping ate the module's code too.
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
      if (node.kind === 'section' && node.section.rows.length === 0) {
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
