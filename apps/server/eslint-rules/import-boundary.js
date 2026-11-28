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
 * - **Ports and composition roots** (`PORTS`, `COMPOSITION_ROOTS` below) are the two named
 *   exceptions, each ONE FILE with a reason and the decided record behind it. An import INTO a port
 *   is no edge: every domain must use it, so counting it measures a decision, not a tangle. A port
 *   is a leaf: a value import from it into another domain is refused outright. Only imports FROM a
 *   composition root are uncounted (it must import every domain); a domain importing the root still
 *   counts. Adding an entry is an edit to this file, with a ledger entry, read by the architect.
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

/**
 * Ports: one file each (a path under `services/`, as {@link inServices} gives it), that every
 * domain may import without making an edge. Each exports only what callers need and imports no
 * other domain.
 */
export const PORTS = [
  {
    path: 'core/capabilities/capability-definition',
    reason:
      'defineCapability and its types: every domain declares its capabilities through it, and it imports no domain.',
    record: 'ADR 261123-170830 (the registry is the one place a capability is defined)',
  },
  {
    path: 'core/agent-tool-kit/agent-tool-kit',
    reason:
      'AgentToolDeps and the tool result helpers: every agent tool file, in whichever domain owns it, is handed and answers through them, and it imports no domain except for types.',
    record:
      'spec computer-side-starts-alone §5.1 (C9a: kernel homes, so no tool file imports runtimes/)',
  },
  {
    path: 'core/tool-names/tool-names',
    reason:
      'How the DorkOS tool server and its tools are named on each runtime: tool files and prompt blocks in many domains spell them, and it imports no domain.',
    record:
      'spec computer-side-starts-alone §5.1 (C9a: kernel homes, so no tool file imports runtimes/)',
  },
  {
    path: 'core/turn-power/marked-turn-copy',
    reason:
      "The words for a marked and an unmarked turn: the copy of every door that names a turn's marks is built from it when its module loads, and it imports no domain.",
    record: 'spec computer-side-starts-alone §5.1 (C9a: the tasks tools text names marked turns)',
  },
];

/**
 * Composition roots: one file each, whose own imports make no edge because its job is to import
 * every domain. A domain importing a root still counts.
 */
export const COMPOSITION_ROOTS = [
  {
    path: 'core/self-description/dorkos-registry',
    reason: "Registers every domain's capabilities in the one registry.",
    record: 'ADR 261123-170830 (the registry is the one place a capability is defined)',
  },
];

const PORT_PATHS = new Set(PORTS.map((entry) => entry.path));
const ROOT_PATHS = new Set(COMPOSITION_ROOTS.map((entry) => entry.path));

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
  const pair = crossingOf(file, specifier);
  if (pair === null || ROOT_PATHS.has(inServices(file))) return null;
  return PORT_PATHS.has(inServices(resolve(dirname(file), specifier))) ? null : pair;
}

/**
 * The pair an import crosses, before ports and composition roots are set aside.
 *
 * @param {string} file - The importing file, absolute.
 * @param {string} specifier - The import's specifier, as written.
 * @returns {string | null}
 */
function crossingOf(file, specifier) {
  if (!specifier.startsWith('.') || isTestPath(file)) return null;
  const from = domainOf(file);
  if (from === null) return null;
  const to = domainOf(resolve(dirname(file), specifier));
  return to === null || to === from ? null : `${from} -> ${to}`;
}

/**
 * The pair an import from a port makes into another domain, which a port may never make.
 *
 * @param {string} file - The importing file, absolute.
 * @param {string} specifier - The import's specifier, as written.
 * @returns {string | null} `null` when `file` is no port or the import stays in its domain.
 */
export function portLeak(file, specifier) {
  return PORT_PATHS.has(inServices(file)) ? crossingOf(file, specifier) : null;
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
          portLeaf:
            "'{{specifier}}' makes {{pair}} from a port. A port is a leaf: every domain imports it, so it imports no domain (PORTS in eslint-rules/import-boundary.js).",
          pair: "'{{specifier}}' makes the import {{pair}}, which is not in eslint-rules/import-boundary.baseline.json. Imports from one services/ domain into another are deliberate: depend on an interface or port the other domain exports, or move a shared type to packages/shared (type-only imports are allowed). See .claude/rules/server-structure.md.",
        },
      },
      create(context) {
        const file = context.filename;
        if (isTestPath(file) || domainOf(file) === null) return {};
        const reach = (node, specifier) => {
          const leak = portLeak(file, specifier);
          if (leak)
            context.report({ node, messageId: 'portLeaf', data: { specifier, pair: leak } });
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
