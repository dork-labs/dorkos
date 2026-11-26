/**
 * The services import boundary (DOR-4924): one domain under `services/` imports another only
 * along a pair that is already there, and the pairs may only go.
 *
 * - **A domain** is a folder under `services/`, and each folder under `services/core/` is its own
 *   domain (`core/config`, `core/auth`). A file directly in `core/` is in domain `core`; a file
 *   directly in `services/` is a domain of its own, named by its stem.
 * - **An edge** is one statement in a non-test file under `services/` whose relative specifier
 *   resolves into a different domain under `services/`. Paths are resolved the computer wall's
 *   way (`inServices` in `computer-wall.js`), never matched as text. Imports from outside
 *   `services/` (routes, lib) and package imports are not counted.
 * - **What a statement is**: the forms the wall counts (`import`, `export … from`,
 *   `import x = require`, a literal `import()`, `declare module`), side-effect imports included,
 *   minus the type-only ones: `import type`, `export type … from`, an import or export-from whose
 *   every specifier is an inline `type`, `import type x = require` and an `import('…')` type. A
 *   type carries no code, so it is no dependency at run time.
 * - The rule refuses a statement whose pair (`from -> to`) is not in
 *   `import-boundary.baseline.json`. The count beside each pair is for
 *   `scripts/import-boundary/check-import-boundary.ts`, which measures with this file's
 *   classifier, refuses a pair's count grown or raised by hand, and lowers it (`--update`).
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inServices, isTestPath } from './computer-wall.js';
import { importsOf } from './space-boundary.js';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = resolve(SERVER, 'src/services');

/** The baseline file, relative to the server package. */
export const BASELINE_FILE = 'eslint-rules/import-boundary.baseline.json';

/** Whether `services/core/<name>` is a folder, cached: it decides a two-segment `core/` path. */
const coreFolders = new Map();
const isCoreFolder = (name) => {
  if (!coreFolders.has(name))
    coreFolders.set(
      name,
      statSync(resolve(SERVICES, 'core', name), { throwIfNoEntry: false })?.isDirectory() ?? false
    );
  return coreFolders.get(name);
};

/**
 * The domain a path under `services/` is in.
 *
 * @param {string} path - An absolute path.
 * @returns {string | null} `null` for a path outside `services/`.
 */
export function domainOf(path) {
  const rel = inServices(path);
  if (rel === null) return null;
  const [first, second, ...rest] = rel.split('/');
  if (first !== 'core' || second === undefined) return first;
  // `core/x` is a file in core/ or core/x/index (inServices drops the `/index`).
  return rest.length > 0 || isCoreFolder(second) ? `core/${second}` : 'core';
}

/**
 * The pair one import makes, or `null` when it is no edge.
 *
 * @param {string} file - The importing file, absolute.
 * @param {string} specifier - The import's specifier, as written.
 * @returns {string | null} `from -> to`; `null` for a package, a path outside `services/`, the
 *   same domain, a test file, and a file not under `services/`.
 */
export function edgeOf(file, specifier) {
  if (!specifier.startsWith('.') || isTestPath(file)) return null;
  const from = domainOf(file);
  if (from === null) return null;
  const to = domainOf(resolve(dirname(file), specifier));
  return to === null || to === from ? null : `${from} -> ${to}`;
}

/**
 * The baseline's pairs: `from -> to` to the number of statements that make it.
 *
 * @returns {Record<string, number>}
 */
export function readBaseline() {
  return JSON.parse(readFileSync(resolve(SERVER, BASELINE_FILE), 'utf8')).edges;
}

/** Read once, when the rule first runs, so a script can import this file to write the baseline. */
let baseline;

/** Whether an `import { … }` or `export { … } from` names only inline types. */
const onlyInlineTypes = (node) => {
  const specifiers = node?.specifiers ?? [];
  if (node?.type === 'ImportDeclaration')
    return (
      specifiers.length > 0 &&
      specifiers.every((s) => s.type === 'ImportSpecifier' && s.importKind === 'type')
    );
  if (node?.type === 'ExportNamedDeclaration')
    return specifiers.length > 0 && specifiers.every((s) => s.exportKind === 'type');
  return false;
};

export default {
  rules: {
    boundary: {
      meta: {
        type: 'problem',
        docs: {
          description: 'A services/ domain imports another only along a pair in the baseline.',
        },
        schema: [],
        messages: {
          pair: "'{{specifier}}' makes the import {{pair}}, which is not in eslint-rules/import-boundary.baseline.json. Imports from one services/ domain into another are deliberate: depend on an interface or port the other domain exports, or move a shared type to packages/shared (type-only imports are allowed). See .claude/rules/server-structure.md.",
        },
      },
      create(context) {
        const file = context.filename;
        if (isTestPath(file) || domainOf(file) === null) return {};
        const reach = (node, specifier) => {
          const pair = edgeOf(file, specifier);
          baseline ??= readBaseline();
          if (pair && !Object.hasOwn(baseline, pair))
            context.report({ node, messageId: 'pair', data: { specifier, pair } });
        };
        return {
          ...importsOf((node, specifier, typeOnly) => {
            if (!typeOnly && !onlyInlineTypes(node.parent)) reach(node, specifier);
          }),
          // `declare module '../x.js' { … }` augments a module and so depends on it, as the wall counts.
          TSModuleDeclaration(node) {
            if (node.id?.type === 'Literal' && typeof node.id.value === 'string')
              reach(node.id, node.id.value);
          },
        };
      },
    },
  },
};
