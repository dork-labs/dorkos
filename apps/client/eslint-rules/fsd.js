import { dirname, resolve, sep } from 'node:path';

/**
 * Vitest helpers whose first argument is a module path rather than ordinary
 * data. They are checked alongside real import declarations because they are
 * the only other way to name a module here, and a mock that reaches into a
 * sibling slice couples the test to that slice's file layout exactly as an
 * import would.
 *
 * This is NOT the `vi.mock()` carve-out written down in
 * `.claude/rules/fsd-layers.md`. That one exists because mocking a specific
 * module requires its concrete path, so an ALIASED deep path
 * (`@/layers/entities/session/model/use-recent-sessions`) has no barrel-shaped
 * alternative and stays legal. A RELATIVE path into another slice has one — the
 * same alias — so there is nothing to carve out.
 */
const VITEST_MODULE_PATH_HELPERS = new Set([
  'mock',
  'doMock',
  'unmock',
  'doUnmock',
  'importActual',
  'importMock',
]);

/**
 * The directory that owns `filePath` as an FSD unit, or `null` if the path is
 * not inside a slice at all.
 *
 * A unit is `<layer>/<slice>` for `entities/`, `features/` and `widgets/`. The
 * `shared/` layer is sliceless — its top-level directories (`ui`, `model`,
 * `lib`, `config`) are segments, not slices — so the whole layer is one unit
 * and `shared/ui/x.tsx -> ../lib/utils` is an ordinary within-unit import.
 *
 * @param filePath Absolute path of the file being linted.
 * @returns The absolute slice root plus its `<layer>/<slice>` label, or `null`
 *   when the file sits above one.
 */
function sliceOf(filePath) {
  const parts = filePath.split(sep);
  const layersIndex = parts.lastIndexOf('layers');
  if (layersIndex < 1 || parts[layersIndex - 1] !== 'src') return null;

  const layer = parts[layersIndex + 1];
  if (!layer) return null;

  const rootEnd = layer === 'shared' ? layersIndex + 2 : layersIndex + 3;
  // The file must live strictly inside the unit, not be the unit directory.
  if (parts.length <= rootEnd) return null;

  return {
    root: parts.slice(0, rootEnd).join(sep),
    label: parts.slice(layersIndex + 1, rootEnd).join('/'),
  };
}

/**
 * Forbids a relative import that leaves its own FSD slice.
 *
 * The `no-restricted-imports` blocks in `eslint.config.js` catch the aliased
 * shape of this mistake (`@/layers/entities/<slice>/model/...`), but they match
 * the specifier as a string, so `../../<slice>/ui/Thing` — the same violation
 * spelled relatively — walked straight past them (DOR-1010). Path arithmetic is
 * the only way to tell "up one segment, still my slice" from "up two, now I am
 * in my neighbour's internals", which is why this is a rule and not another
 * pattern in that list.
 *
 * What stays legal is everything that does not leave the slice: `./sibling`,
 * `../model/state` from `ui/`, `../ui/Thing` from a slice-root `__tests__/`.
 * Those are deliberate and common — the rule never sees them.
 *
 * Two shapes are knowingly outside the arithmetic, because neither resolves in
 * this toolchain either: a dynamic `import()` built from a template literal (no
 * static path to resolve) and a backslash-separated specifier (not a module
 * path on any platform Vite serves). Both would be dead code to handle.
 */
const noCrossSliceRelativeImport = {
  meta: {
    type: 'problem',
    docs: {
      description: "Disallow relative imports that reach outside the importing file's FSD slice.",
      url: 'https://github.com/dork-labs/dorkos/blob/main/.claude/rules/fsd-layers.md',
    },
    schema: [],
    messages: {
      crossSlice:
        "FSD violation: the relative path '{{specifier}}' leaves this file's own slice ({{slice}}). " +
        'Reach another slice through its barrel — `@/layers/<layer>/<slice>` — never a relative path into its internals.',
    },
  },

  create(context) {
    const filePath = context.filename;
    const slice = sliceOf(filePath);
    if (!slice) return {};

    /**
     * Report `node` when it is a relative specifier resolving outside the slice.
     *
     * @param node The string literal holding the module path.
     */
    function checkSpecifier(node) {
      if (!node || node.type !== 'Literal' || typeof node.value !== 'string') return;
      if (!node.value.startsWith('.')) return;

      const target = resolve(dirname(filePath), node.value);
      if (target === slice.root || target.startsWith(slice.root + sep)) return;

      context.report({
        node,
        messageId: 'crossSlice',
        data: { specifier: node.value, slice: slice.label },
      });
    }

    return {
      ImportDeclaration: (node) => checkSpecifier(node.source),
      ExportNamedDeclaration: (node) => checkSpecifier(node.source),
      ExportAllDeclaration: (node) => checkSpecifier(node.source),
      ImportExpression: (node) => checkSpecifier(node.source),
      CallExpression: (node) => {
        const { callee } = node;
        if (
          callee.type === 'MemberExpression' &&
          !callee.computed &&
          callee.object.type === 'Identifier' &&
          callee.object.name === 'vi' &&
          callee.property.type === 'Identifier' &&
          VITEST_MODULE_PATH_HELPERS.has(callee.property.name)
        ) {
          checkSpecifier(node.arguments[0]);
        }
      },
    };
  },
};

/** ESLint plugin carrying the client's FSD-specific rules. */
export default {
  meta: { name: 'fsd' },
  rules: { 'no-cross-slice-relative-import': noCrossSliceRelativeImport },
};
