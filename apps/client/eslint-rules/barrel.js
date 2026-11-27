/**
 * Barrel-only imports between slices (DOR-4935): a file reaches a slice of `entities/`,
 * `features/` or `widgets/` that is not its own through the slice's `index.ts`, never a path
 * inside it. The deep imports that were there when the rule landed sit in
 * `barrel.baseline.json`, and they may only go.
 *
 * - **What counts** is an aliased specifier `@/layers/<layer>/<slice>/<path>` in an `import` or
 *   an `export … from`, type-only imports included: a type reached past the barrel couples you
 *   to the file layout as much as a value does. `@/layers/<layer>/<slice>` and an explicit
 *   `…/<slice>/index` are the barrel and never count.
 * - **A dynamic `import()` is not counted.** It is how a lazy chunk names its entry, and that
 *   entry has to be the module itself: the slice's barrel is usually in the static graph
 *   already, so `import()` of it splits nothing off (`widgets/team/ui/TeamRoute.tsx` loads
 *   `features/mesh/ui/TopologyGraph` that way, to keep React Flow out of the first bundle). The
 *   other `import()` of a deep path in this tree sits inside a `vi.mock()` factory, which is the
 *   mock carve-out below.
 * - **Your own slice** is yours to reach however you like, so a file in `features/chat/` naming
 *   `@/layers/features/chat/model/x` is not counted.
 * - **Not counted, because another rule owns it:** a relative path (`fsd/no-cross-slice-relative-import`
 *   resolves it, and refuses it outright when it leaves the slice), an entity reaching a sibling
 *   entity (the `entities/**` block's `no-restricted-imports` pattern), and `vi.mock()` with an
 *   aliased deep path, which is the carve-out `.claude/rules/fsd-layers.md` records: a mock
 *   needs the concrete module, and it replaces that module rather than depending on it.
 *   `shared/` is not a target either: its segments are not slices, and several of its deep
 *   paths (`shared/lib/transport`) are deliberately off its barrel.
 * - **The ratchet.** A file with more deep imports than its baseline entry fails on each of
 *   them; a file with fewer fails once, on the file, until its entry is lowered by hand (or
 *   removed, at zero). Only test files may hold an entry: every non-test file was clean when
 *   the rule landed, so the baseline has nothing to grant one. `__tests__/cross-slice-import-lint.test.ts`
 *   holds that, lints every listed file, and fails on an entry that no longer matches its file.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/client`. */
const CLIENT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `apps/client/src/layers`, for telling which slice a file sits in. */
const LAYERS = resolve(CLIENT, 'src/layers');

/** The baseline file, relative to the client package. */
const BASELINE_FILE = 'eslint-rules/barrel.baseline.json';

/** The layers whose slices are reached through a barrel. `shared/` has segments, not slices. */
const SLICED_LAYERS = new Set(['entities', 'features', 'widgets']);

/** `@/layers/<layer>/<slice>/<path>`: the three parts of a deep import, or no match. */
const DEEP_SPECIFIER = /^@\/layers\/([^/]+)\/([^/]+)\/(.+)$/;

/**
 * The baseline's entries: a file, relative to the client package, to the deep imports it may
 * still hold.
 *
 * @returns {Record<string, number>}
 */
function readBaseline() {
  return JSON.parse(readFileSync(resolve(CLIENT, BASELINE_FILE), 'utf8')).files;
}

const BASELINE = readBaseline();

/**
 * The `<layer>/<slice>` a file sits in, or `null` above every slice.
 *
 * @param {string} file - An absolute path.
 * @returns {{ layer: string, slice: string } | null}
 */
function ownSliceOf(file) {
  const rel = relative(LAYERS, file);
  if (rel.startsWith('..')) return null;
  const [layer, slice, ...rest] = rel.split(sep);
  return rest.length > 0 ? { layer, slice } : null;
}

/**
 * Whether one specifier reaches past the barrel of a slice that is not the importer's own.
 *
 * @param {{ layer: string, slice: string } | null} own - The importing file's slice, or `null`
 *   for a file above every slice (`src/app/`, `src/__tests__/`).
 * @param {string} specifier - The specifier, as written.
 * @returns {boolean}
 */
function isDeepImport(own, specifier) {
  const match = DEEP_SPECIFIER.exec(specifier);
  if (match === null) return false;
  const [, layer, slice, path] = match;
  if (!SLICED_LAYERS.has(layer) || path === 'index') return false;
  if (own !== null && own.layer === layer && own.slice === slice) return false;
  // Entity to entity is the `entities/**` block's pattern, which is stricter: it refuses a deep
  // alias into the file's own slice too. Counting it here as well would report it twice.
  if (own !== null && own.layer === 'entities' && layer === 'entities') return false;
  return true;
}

export default {
  meta: { name: 'barrel' },
  rules: {
    'import-through-barrel': {
      meta: {
        type: 'problem',
        docs: {
          description: 'Reach another slice through its barrel, never a path inside it.',
          url: 'https://github.com/dork-labs/dorkos/blob/main/.claude/rules/fsd-layers.md',
        },
        schema: [],
        messages: {
          deep: "FSD violation: '{{specifier}}' reaches past a slice's barrel. Import from `@/layers/{{layer}}/{{slice}}`, exporting what you need from its index.ts. This file has {{count}} such imports; its baseline allows {{allowed}}.",
          stale:
            'This file has {{count}} deep imports past a slice barrel and its baseline allows {{allowed}}. Lower its entry in apps/client/eslint-rules/barrel.baseline.json (remove it at 0).',
        },
      },
      create(context) {
        const file = context.filename;
        const own = ownSliceOf(file);
        const found = [];

        /** @param {import('estree').Node | null | undefined} node */
        const check = (node) => {
          if (!node || node.type !== 'Literal' || typeof node.value !== 'string') return;
          if (isDeepImport(own, node.value)) found.push(node);
        };

        return {
          ImportDeclaration: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          'Program:exit'(program) {
            const allowed = BASELINE[relative(CLIENT, file).split(sep).join('/')] ?? 0;
            const count = found.length;
            if (count > allowed) {
              for (const node of found) {
                const [, layer, slice] = DEEP_SPECIFIER.exec(node.value);
                context.report({
                  node,
                  messageId: 'deep',
                  data: { specifier: node.value, layer, slice, count, allowed },
                });
              }
            } else if (count < allowed) {
              context.report({ node: program, messageId: 'stale', data: { count, allowed } });
            }
          },
        };
      },
    },
  },
};
