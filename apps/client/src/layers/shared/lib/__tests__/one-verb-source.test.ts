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
 * The three files allowed to name the tool-phrasing rung directly: where it is
 * defined, the ladder that is its one caller, and that definition's own test.
 * Everything else must go through `activityVerb`.
 */
const LADDER_INSIDERS = new Set([
  'shared/lib/tool-labels.ts',
  'shared/lib/activity-verb.ts',
  'shared/lib/__tests__/tool-labels.test.ts',
  // This file. It holds sample import text as executable proof that the
  // detector below works, and that text is indistinguishable from the real
  // thing on purpose.
  'shared/lib/__tests__/one-verb-source.test.ts',
]);

/**
 * One `import … from '…'` statement.
 *
 * Bounded by `[^;]*?` so a match can never run from one statement's `import`
 * past a later mention of the rung and on to some third statement's `from` —
 * which is exactly what a lazy `[\s\S]*?` did on the first draft of this file,
 * making it accuse itself of what its own prose warns about.
 */
const IMPORT_STATEMENT = /(^|\n)\s*import\b[^;]*?\bfrom\s+['"][^'"]+['"]/g;

/** Whether any single import statement in this source pulls in the rung. */
function importsTheRung(source: string): boolean {
  for (const match of source.matchAll(IMPORT_STATEMENT)) {
    if (match[0].includes('formatActivityLabel')) return true;
  }
  return false;
}

describe('the honesty ladder is the only verb source (BC-37)', () => {
  it('reads the client sources at all — a scan that matches nothing proves nothing', () => {
    // Every assertion below is only as strong as this one. If the walk breaks
    // or the layout moves, the checks would pass by finding nothing to check.
    expect(SOURCES.length).toBeGreaterThan(500);
    expect(SOURCES.some((file) => file.path === 'shared/lib/activity-verb.ts')).toBe(true);
  });

  it('lets nothing outside the ladder import the tool-phrasing rung', () => {
    const offenders = SOURCES.filter(
      (file) => importsTheRung(file.source) && !LADDER_INSIDERS.has(file.path)
    ).map((file) => file.path);
    expect(
      offenders,
      'call activityVerb(lifecycle, activity) instead — one turn, one phrasing (BC-37)'
    ).toEqual([]);
  });

  it('keeps the rung out of the shared barrel, so there is no importable path to it', () => {
    // The scan above only catches a caller that has already been written. This
    // catches the thing that makes writing one easy: an autocomplete entry.
    const barrel = SOURCES.find((file) => file.path === 'shared/lib/index.ts');
    expect(barrel).toBeDefined();
    expect(barrel?.source).not.toMatch(/^\s*formatActivityLabel,\s*$/m);
  });

  it('proves the import detector catches what a bare word search does not', () => {
    // Red-before evidence, kept executable. `strip-state.ts` carried exactly
    // the first of these until this task rewired it.
    expect(importsTheRung("import { formatActivityLabel } from '@/layers/shared/lib';")).toBe(true);
    expect(importsTheRung('import {\n  formatActivityLabel,\n} from "./tool-labels";')).toBe(true);
    // …and does not fire on the many files that merely TALK about it, which is
    // what makes the offender list above trustworthy rather than noisy.
    expect(importsTheRung(' * see {@link formatActivityLabel} for the rung')).toBe(false);
    // Nor across two unrelated statements with a mention stranded between them,
    // which is the false positive that made the first draft of this file fail
    // on itself.
    expect(
      importsTheRung(
        'import { readFileSync } from "node:fs";\n' +
          '/** formatActivityLabel is the rung. */\n' +
          'import { activityVerb } from "../activity-verb";\n'
      )
    ).toBe(false);
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
