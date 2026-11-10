/**
 * The turn-context record is private to the person (Security, Nov 8): no
 * route, agent tool, extension or feedback bundle may read it until a later
 * phase is reviewed. These checks scan every workspace source file for any way
 * a reader could reach it, so one cannot be added without this test changing
 * in review:
 *
 * - naming its tables, in code (`turnContextBodies`) or in SQL (`turn_context_bodies`),
 *   anywhere but the store and the schema;
 * - importing the record's module, statically or with `import()`, from anywhere
 *   but its writers;
 * - calling its one reader, `listTurnContextsForSession(`, anywhere but the store.
 *
 * Each rule is run against made-up readers below, and each must catch them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { lexWithoutComments } from '../../../../../../../scripts/lib/code-only.mjs';

const REPO = path.resolve(__dirname, '../../../../../../..');
const SERVER_SRC = path.join(REPO, 'apps/server/src');
const RECORD_DIR = path.join(SERVER_SRC, 'services/session/turn-context') + path.sep;
const STORE = 'apps/server/src/services/session/turn-context/turn-context-store.ts';
const SCHEMA = 'packages/db/src/schema/session/turn-context.ts';
/** Files allowed to name the tables freely: the store and the schema. */
const MAY_NAME_TABLES = new Set([STORE, SCHEMA]);
/**
 * The backup scrub (DOR-4001) may name the text table only to empty it: its
 * one constant, a presence check and the DELETE. Any other statement there
 * that reaches the table is a reader (S7).
 */
const SCRUB = 'packages/db/src/snapshot-scrub.ts';
const SCRUB_CONSTANT = /const RECORDED_TEXT_TABLE = 'turn_context_bodies';/;
const SCRUB_SQL_ALLOWED =
  /^(?:SELECT 1 FROM (?:\$\{RECORDED_TEXT_TABLE\}|turn_context_bodies) LIMIT 1|DELETE FROM (?:\$\{RECORDED_TEXT_TABLE\}|turn_context_bodies))$/;

/** Files allowed to import the record, relative to the repo. Writers only. */
const ALLOWED_IMPORTERS = new Set([
  // The installer and the hourly sweep.
  'apps/server/src/startup/steps/core-stores.ts',
  'apps/server/src/startup/steps/after-listen.ts',
  // Deletion with the session, live and at boot (DOR-4002).
  'apps/server/src/services/session/message-dispatcher/queue-upkeep.ts',
  'apps/server/src/services/session/catalog/boot-session-reconcile.ts',
  // The four adapters, each at the point it hands the prompt over.
  'apps/server/src/services/runtimes/claude-code/messaging/turn-context/turn-context-record.ts',
  'apps/server/src/services/runtimes/codex/turn-input.ts',
  'apps/server/src/services/runtimes/opencode/messaging/turn-input.ts',
  'apps/server/src/services/runtimes/doe/turn-context-record.ts',
]);

/** The tables, by their code names and their exact SQL names (never Codex's `turn_context`). */
const TABLE_NAME = /\bturnContext(?:s|Parts|Bodies)\b/;
/** The SQL names, in any case: SQLite ignores case in a table name (DOR-4006). */
const SQL_TABLE_NAME = /\bturn_context(?:s|_parts|_bodies)\b/i;
/** Every module specifier: `from '…'`, `import('…')`, `require('…')`. */
const SPECIFIER = /(?:from\s*|import\s*\(\s*|require\s*\(\s*)['"`]([^'"`]+)['"`]/g;

interface SourceFile {
  /** Path relative to the repo root, with `/`. */
  rel: string;
  source: string;
}

function sourceFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return ['__tests__', 'node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(full);
    }
    return /\.(?:ts|tsx|mts|cts|js|mjs)$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [full]
      : [];
  });
}

/** Every non-test source file in the workspace's apps and packages. */
function workspaceSources(): SourceFile[] {
  return ['apps', 'packages']
    .flatMap((top) =>
      fs.readdirSync(path.join(REPO, top)).map((name) => path.join(REPO, top, name, 'src'))
    )
    .flatMap(sourceFiles)
    .map((full) => ({
      rel: path.relative(REPO, full).split(path.sep).join('/'),
      source: fs.readFileSync(full, 'utf8'),
    }));
}

/** Whether a file imports, in any form, a module inside the record's directory. */
function importsRecord(file: SourceFile): boolean {
  const dir = path.dirname(path.join(REPO, file.rel));
  return [...file.source.matchAll(SPECIFIER)].some((match) => {
    const spec = match[1]!;
    if (!spec.startsWith('.')) return /services\/session\/turn-context(?:\/|$)/.test(spec);
    return path.resolve(dir, spec).startsWith(RECORD_DIR);
  });
}

/** Whether the scrub reaches the text table only through its allowed statements. */
function scrubStaysAWriter(source: string): boolean {
  // Comments say what the file does; only code can read anything. The shared
  // lexer blanks them and keeps every string, which is what is read below.
  const code = lexWithoutComments(source).code.replace(SCRUB_CONSTANT, '');
  const strings = [...code.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g)].map((m) => m[2]!);
  const touching = strings.filter(
    (text) => /RECORDED_TEXT_TABLE/.test(text) || SQL_TABLE_NAME.test(text) || TABLE_NAME.test(text)
  );
  const outsideStrings = strings.reduce((rest, text) => rest.replace(text, ''), code);
  // The one bare use: the presence check (`sqlite_master … name = ?`) binds the constant.
  const bare = (outsideStrings.match(/[^\n]*RECORDED_TEXT_TABLE[^\n]*/g) ?? []).filter(
    (line) => !/^\s*\.get\(RECORDED_TEXT_TABLE\);\s*$/.test(line)
  );
  return (
    touching.every((text) => SCRUB_SQL_ALLOWED.test(text.trim())) &&
    !SQL_TABLE_NAME.test(outsideStrings) &&
    !TABLE_NAME.test(outsideStrings) &&
    bare.length === 0
  );
}

/** Every way the given sources reach the record that these rules do not allow. */
function violations(files: readonly SourceFile[]): string[] {
  const found: string[] = [];
  for (const file of files) {
    const inRecord = path.join(REPO, file.rel).startsWith(RECORD_DIR);
    const namesTable = TABLE_NAME.test(file.source) || SQL_TABLE_NAME.test(file.source);
    if (file.rel === SCRUB) {
      if (!scrubStaysAWriter(file.source)) {
        found.push(`${file.rel}: reaches the text table beyond its scrub`);
      }
    } else if (!MAY_NAME_TABLES.has(file.rel) && namesTable) {
      found.push(`${file.rel}: names a turn-context table`);
    }
    if (!inRecord && !ALLOWED_IMPORTERS.has(file.rel) && importsRecord(file)) {
      found.push(`${file.rel}: imports the turn-context record`);
    }
    if (file.rel !== STORE && /\blistTurnContextsForSession\s*\(/.test(file.source)) {
      found.push(`${file.rel}: calls the turn-context reader`);
    }
  }
  return found;
}

describe('turn-context privacy', () => {
  const real = workspaceSources();

  it('scans the whole workspace, writers and store included', () => {
    const scanned = new Set(real.map((file) => file.rel));
    for (const file of [STORE, SCHEMA, ...ALLOWED_IMPORTERS])
      expect(scanned.has(file), file).toBe(true);
  });

  it('finds no reader of the record anywhere: only its writers reach it', () => {
    expect(violations(real)).toEqual([]);
  });

  it('every allowed importer really imports it (the list cannot go stale)', () => {
    for (const rel of ALLOWED_IMPORTERS) {
      expect(importsRecord(real.find((file) => file.rel === rel)!), rel).toBe(true);
    }
  });

  describe('catches each made-up reader', () => {
    const route = 'apps/server/src/routes/made-up-reader.ts';
    const mutants: Record<string, SourceFile> = {
      'a static relative import': {
        rel: route,
        source:
          "import { getTurnContextStore } from '../services/session/turn-context/record-turn-context.js';",
      },
      'a table read through @dorkos/db': {
        rel: route,
        source:
          "import { turnContextBodies } from '@dorkos/db';\nexport const rows = (db) => db.select().from(turnContextBodies).all();",
      },
      'a dynamic import': {
        rel: route,
        source:
          "export const load = async () => (await import('../services/session/turn-context/index.js')).getTurnContextStore();",
      },
      'a reader inside the backup scrub, by name': {
        rel: SCRUB,
        source: `${fs.readFileSync(path.join(REPO, SCRUB), 'utf8')}\nexport const readBodies = (db) => db.prepare('SELECT body FROM turn_context_bodies').all();`,
      },
      'a reader inside the backup scrub, through its constant': {
        rel: SCRUB,
        source: `${fs.readFileSync(path.join(REPO, SCRUB), 'utf8')}\nexport const readBodies = (db) => db.prepare(\`SELECT body FROM \${RECORDED_TEXT_TABLE}\`).all();`,
      },
      'raw SQL in upper case': {
        rel: route,
        source:
          "export const rows = (db) => db.$client.prepare('SELECT BODY FROM TURN_CONTEXT_BODIES').all();",
      },
      'raw SQL': {
        rel: route,
        source:
          "export const rows = (db) => db.$client.prepare('SELECT body FROM turn_context_bodies').all();",
      },
      'a new reader inside an allowed importer': {
        rel: 'apps/server/src/services/session/message-dispatcher/queue-upkeep.ts',
        source:
          "import { getTurnContextStore } from '../turn-context/record-turn-context.js';\nexport const peek = (id) => getTurnContextStore()?.listTurnContextsForSession(id);",
      },
    };
    for (const [name, mutant] of Object.entries(mutants)) {
      it(name, () => {
        const files = [...real.filter((file) => file.rel !== mutant.rel), mutant];
        expect(violations(files)).not.toEqual([]);
      });
    }

    it('but not Codex’s own `turn_context` rollout lines', () => {
      const codex = { rel: route, source: "if (line.type === 'turn_context') return;" };
      expect(violations([codex])).toEqual([]);
    });
  });

  it('is not named anywhere a feedback report is built', () => {
    for (const file of [
      'routes/feedback.ts',
      'services/core/feedback-reporter.ts',
      'lib/log-excerpt.ts',
      'lib/transcript-excerpt.ts',
    ]) {
      const source = fs.readFileSync(path.join(SERVER_SRC, file), 'utf8');
      expect(source, file).not.toMatch(/turn[-_]?context|turnContext|dork\.db/i);
    }
  });
});
