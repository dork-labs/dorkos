/**
 * The computer wall (spec `computer-side-starts-alone` §4, DOR-5158): computer-side code stops
 * reaching into the space side, and the reaches it still has may only go.
 *
 * - **The side map** is `sides.json`: every folder and root file under `src/services/` is
 *   `computer`, `space`, `kernel` or `frontDoor`, the longest matching path winning. A non-test
 *   file the map does not place fails, so a new folder picks its side in the pull request that
 *   adds it.
 * - **Three columns**, counted for each non-test computer-side file: `space`, the statements that
 *   reach a space-side path; `frontDoor`, the same into a front-door path; `tables`, the names
 *   imported from `@dorkos/db` that are on the side map's space table list.
 * - **What a statement is** (§1.2): `import` and `export … from`, `import x = require`, a literal
 *   `import()` and an `import('…')` type, and `declare module`, type-only ones included. Only
 *   relative paths count, each resolved against the file (never matched as text), with `.js`,
 *   `.ts` and `.tsx` dropped and a trailing `/index` read as its folder. A bare `require()` call is
 *   not a statement of TypeScript and is not counted.
 * - Each column of a file may hold no more than its entry in `computer-wall.baseline.json`, and a
 *   file below its entry fails too, until `pnpm check:computer-wall -- --update` lowers it.
 *
 * The turn-port rule (`turn-port-boundary.js`) keeps its own side list. The baseline's own rules
 * (no entry raised or added by hand) are `scripts/computer-wall/check-computer-wall.ts`, which
 * counts with this file's classifier so the two can never disagree about a path.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsOf } from './space-boundary.js';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = resolve(SERVER, 'src/services');

/** The baseline file, relative to the server package. */
export const BASELINE_FILE = 'eslint-rules/computer-wall.baseline.json';

/** The side map, relative to the server package. */
export const SIDES_FILE = 'eslint-rules/sides.json';

/** The baseline's columns, in the order a person reads them. */
export const COLUMNS = ['space', 'frontDoor', 'tables'];

/** The four sides a path under `services/` can be on. */
export const SIDES = ['computer', 'space', 'kernel', 'frontDoor'];

/** The package whose table names the `tables` column reads. */
export const DB_PACKAGE = '@dorkos/db';

/**
 * The space-side folders whose imports from runtimes the permission gate note asks a ratchet for
 * (`specs/space-computer-contract/design-permission-gate.md` §6). They are part of the `space`
 * column; the checker prints their sum on its own line.
 */
export const GATE_NOTE_FOLDERS = [
  'core/turn-power',
  'core/agent-identity',
  'core/capabilities',
  'core/approvals',
  'core/permissions',
];

/** Test files and fixtures, which the wall does not count. */
const TEST_PATH = /(^|\/)(__tests__|__fixtures__)\/|\.(test|spec)\.tsx?$/u;

/**
 * A path under `services/`, relative to it, with `/` separators, no extension and no trailing
 * `/index`; `null` for a path outside `services/` or `services/` itself.
 *
 * @param {string} path - An absolute path.
 * @returns {string | null}
 */
export function inServices(path) {
  const rel = relative(SERVICES, path).split(sep).join('/');
  if (rel === '' || rel.startsWith('..') || rel.startsWith('/')) return null;
  return rel.replace(/\.(?:[cm]?js|tsx?)$/u, '').replace(/\/index$/u, '');
}

/**
 * The side map as written: each side's paths and each table list.
 *
 * @returns {{ sides: Record<string, string[]>, tables: { computer: string[], space: string[] } }}
 */
export function readSides() {
  return JSON.parse(readFileSync(resolve(SERVER, SIDES_FILE), 'utf8'));
}

const SIDE_MAP = readSides();
/** Each placed path, without its extension, to its side, longest first. */
const PLACED = Object.entries(SIDE_MAP.sides)
  .flatMap(([side, paths]) => paths.map((path) => [path.replace(/\.tsx?$/u, ''), side]))
  .sort(([a], [b]) => b.length - a.length);
const SPACE_TABLES = new Set(SIDE_MAP.tables.space);

/**
 * Which side a file is on.
 *
 * @param {string} file - An absolute path.
 * @returns {'computer' | 'space' | 'kernel' | 'frontDoor' | 'unplaced' | 'outside'} `outside` for
 *   a path not under `services/`; `unplaced` for one under it that the side map does not place.
 */
export function sideOf(file) {
  const rel = inServices(file);
  if (rel === null) return 'outside';
  const hit = PLACED.find(([path]) => rel === path || rel.startsWith(`${path}/`));
  return hit ? hit[1] : 'unplaced';
}

/**
 * Whether a file is a test or a fixture, which the wall does not count.
 *
 * @param {string} file - An absolute path, or one relative to anything above `services/`.
 * @returns {boolean}
 */
export function isTestPath(file) {
  return TEST_PATH.test(file.split(sep).join('/'));
}

/**
 * Which column one import from a computer-side file counts in.
 *
 * @param {string} file - The importing file, absolute.
 * @param {string} specifier - The import's specifier, as written.
 * @returns {'space' | 'frontDoor' | null} `null` for a package, a path on the computer side or the
 *   kernel, a path outside `services/`, and every import of a file that is not computer side.
 */
export function crossing(file, specifier) {
  if (!specifier.startsWith('.') || sideOf(file) !== 'computer') return null;
  const to = sideOf(resolve(dirname(file), specifier));
  return to === 'space' || to === 'frontDoor' ? to : null;
}

/**
 * Whether a name `@dorkos/db` exports is on the space table list.
 *
 * @param {string} name - A Drizzle export name.
 * @returns {boolean}
 */
export function isSpaceTable(name) {
  return SPACE_TABLES.has(name);
}

/**
 * The baseline's entries: a file, relative to the server package, to what each column may still
 * hold.
 *
 * @returns {Record<string, { space: number, frontDoor: number, tables: number }>}
 */
export function readBaseline() {
  return JSON.parse(readFileSync(resolve(SERVER, BASELINE_FILE), 'utf8')).files;
}

const BASELINE = readBaseline();

/** The name a specifier of `import { a as b }` or `export { a as b } from` takes from the module. */
const importedName = (spec) => {
  const named = spec.type === 'ImportSpecifier' ? spec.imported : spec.local;
  return named.type === 'Identifier' ? named.name : String(named.value);
};

export default {
  rules: {
    wall: {
      meta: {
        type: 'problem',
        docs: {
          description: 'Computer-side code imports no space-side code, front door or space table.',
        },
        schema: [],
        messages: {
          space:
            "'{{specifier}}' is space-side code ({{target}}). Computer-side code reaches the space side through a port (spec computer-side-starts-alone §5), and a type it needs belongs in packages/shared. This file has {{count}} such imports; its baseline allows {{allowed}}.",
          frontDoor:
            "'{{specifier}}' is front-door code ({{target}}). Computer-side code takes a front-door check handed in through a kernel interface (spec computer-side-starts-alone §7.5). This file has {{count}} such imports; its baseline allows {{allowed}}.",
          tables:
            "'{{specifier}}' is a space table. Computer-side code reads and writes only the computer tables in eslint-rules/sides.json (spec computer-side-starts-alone §6). This file names {{count}} space tables; its baseline allows {{allowed}}.",
          stale:
            "This file's {{column}} count is {{count}} and its baseline allows {{allowed}}. Lock the drop in: pnpm check:computer-wall -- --update.",
          unplaced:
            '{{path}} is in no folder of the side map. Add its folder to apps/server/eslint-rules/sides.json as computer, space, kernel or frontDoor (spec computer-side-starts-alone §1.1).',
        },
      },
      create(context) {
        const file = context.filename;
        if (isTestPath(file)) return {};
        const side = sideOf(file);
        if (side === 'unplaced') {
          return {
            Program(program) {
              context.report({
                node: program,
                messageId: 'unplaced',
                data: { path: relative(SERVER, file).split(sep).join('/') },
              });
            },
          };
        }
        if (side !== 'computer') return {};

        /** @type {Record<string, { node: unknown, specifier: string, target?: string }[]>} */
        const found = { space: [], frontDoor: [], tables: [] };
        const reach = (node, specifier) => {
          const column = crossing(file, specifier);
          if (column)
            found[column].push({
              node,
              specifier,
              target: `services/${inServices(resolve(dirname(file), specifier))}`,
            });
        };
        const tables = (node) => {
          if (node.source?.value !== DB_PACKAGE) return;
          for (const spec of node.specifiers ?? []) {
            if (spec.type !== 'ImportSpecifier' && spec.type !== 'ExportSpecifier') continue;
            const name = importedName(spec);
            if (isSpaceTable(name)) found.tables.push({ node: spec, specifier: name });
          }
        };
        const imports = importsOf(reach);
        return {
          ...imports,
          ImportDeclaration(node) {
            imports.ImportDeclaration(node);
            tables(node);
          },
          ExportNamedDeclaration(node) {
            imports.ExportNamedDeclaration(node);
            tables(node);
          },
          // `declare module '../x.js' { … }` augments a module and so depends on it (§1.2).
          TSModuleDeclaration(node) {
            if (node.id?.type === 'Literal' && typeof node.id.value === 'string')
              reach(node.id, node.id.value);
          },
          'Program:exit'(program) {
            const entry = BASELINE[relative(SERVER, file).split(sep).join('/')];
            for (const column of COLUMNS) {
              const hits = found[column];
              const allowed = entry?.[column] ?? 0;
              const count = hits.length;
              if (count > allowed) {
                for (const hit of hits)
                  context.report({
                    node: hit.node,
                    messageId: column,
                    data: { specifier: hit.specifier, target: hit.target, count, allowed },
                  });
              } else if (count < allowed) {
                context.report({
                  node: program,
                  messageId: 'stale',
                  data: { column, count, allowed },
                });
              }
            }
          },
        };
      },
    },
  },
};
