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
 * (`@/layers/entities/session/model/query/use-recent-sessions`) has no barrel-shaped
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
 * @returns The absolute slice root, the app's `src` root, the repo-root
 *   `scripts/` directory, and the `<layer>/<slice>` label — or `null` when the
 *   file sits above a slice.
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

  // `<repo>/apps/<app>/src/layers/...` — so the repo root is three segments
  // above `src`. Derived rather than searched for: a marker hunt (`.git`,
  // `pnpm-workspace.yaml`) touches the filesystem from inside a lint rule, and a
  // checkout without the marker would silently widen the exemption to
  // everything, which is the direction that must never fail open.
  const srcIndex = layersIndex - 1;
  return {
    root: parts.slice(0, rootEnd).join(sep),
    srcRoot: parts.slice(0, layersIndex).join(sep),
    scriptsRoot: [...parts.slice(0, srcIndex - 2), 'scripts'].join(sep),
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
 *
 * So is a relative path to the repo-root `scripts/` directory — specifically
 * `scripts/lib/code-only.mjs`, which four guards here read source with
 * (DOR-1714). That one is not a cross-slice import in either direction: there is
 * no slice at the other end and no barrel to route through, so the message this
 * rule would print asks for something that does not exist.
 *
 * The exemption is scoped to that prefix and NOT to "anything outside `src/`",
 * which is where it started and which was too wide. `../../../../../../../
 * packages/shared/src/transport` also leaves `src/`, and it is a deep relative
 * import into another workspace package — a real violation of the same
 * encapsulation idea one level up, and one that has a correct spelling
 * (`@dorkos/shared/transport`) to be redirected to. Nothing in the tree does it
 * today; the point of a narrow exemption is that nothing can start.
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
      outsideApp:
        "FSD violation: the relative path '{{specifier}}' leaves this app's `src/` entirely. " +
        'Reach another workspace package by its package name — `@dorkos/<package>/<subpath>` — never a relative path into its source.',
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
      // The repo-root `scripts/` directory is the one place outside this app a
      // relative path may legitimately reach — see the rule's docblock. Scoped
      // to that prefix on purpose: a deep relative import into another
      // WORKSPACE PACKAGE also leaves `src/`, has a correct aliased spelling,
      // and still reds here.
      if (target.startsWith(slice.scriptsRoot + sep)) return;

      // Two different mistakes, so two different messages. Telling somebody who
      // reached into `packages/shared/src/` to "use the slice's barrel" names a
      // thing that does not exist and sends them looking for it; the fix they
      // actually want is the package name.
      if (!target.startsWith(slice.srcRoot + sep)) {
        context.report({ node, messageId: 'outsideApp', data: { specifier: node.value } });
        return;
      }

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

/**
 * The feature whose `model/` segment owns `filePath`, or `null`.
 *
 * `model/` at ANY depth below it counts — `model/rules/x.ts` and
 * `model/__tests__/x.test.ts` are model code as much as `model/x.ts` is.
 *
 * @param filePath Absolute path of the file being linted.
 * @returns The feature's slice name, or `null` when the file is not model code
 *   in a feature.
 */
function featureModelOf(filePath) {
  const parts = filePath.split(sep);
  const layersIndex = parts.lastIndexOf('layers');
  if (layersIndex < 1 || parts[layersIndex - 1] !== 'src') return null;
  if (parts[layersIndex + 1] !== 'features') return null;
  if (parts[layersIndex + 3] !== 'model') return null;
  return parts[layersIndex + 2] ?? null;
}

/** `@/layers/features/<slice>/model`, or a path below it. */
const FEATURE_MODEL_SPECIFIER = /^@\/layers\/features\/([^/]+)\/model(?:\/|$)/;

/**
 * Forbids a feature's model code from importing another feature's model code.
 *
 * `.claude/rules/fsd-layers.md` has said this since the layer rules were
 * written — "a feature's model/hooks must never import from another feature's
 * model/hooks", because two features' business logic coupling is how a circular
 * dependency between screens starts — and nothing enforced it (DOR-1284). What
 * the same file ALLOWS is the other half of the sentence, and this rule is
 * careful to leave it alone: UI composition across features is normal, and so
 * is reaching a sibling through its public barrel. `@/layers/features/composer`
 * from `chat/model/` is a contract; `@/layers/features/composer/model/x` is that
 * feature's private wiring.
 *
 * Local code rather than another `no-restricted-imports` pattern, for two
 * reasons. A pattern matches the specifier as a string, so it cannot tell a
 * sibling's model from your OWN feature's model — `@/layers/features/chat/model/x`
 * read from inside `chat/` is fine, and the pattern would red it. And
 * `no-restricted-imports` options REPLACE rather than merge, so a second block
 * scoped to a feature's `model` segment would silently drop the widgets ban the
 * `features/**` block above it carries, for exactly those files.
 *
 * Two shapes are deliberately not reported, each because another rule already
 * owns it:
 *
 * - The relative spelling (`../../composer/model/x`) is an error under
 *   `no-cross-slice-relative-import`, which resolves the path instead of
 *   matching it, and does so from anywhere in the slice rather than only from
 *   `model/`.
 * - `vi.mock('@/layers/features/composer/model/x')` is a stub, not a use. It
 *   creates no dependency on the sibling's logic — it REPLACES it — and the
 *   concrete path is the only spelling a mock has, which is the same carve-out
 *   `.claude/rules/fsd-layers.md` already records for the barrel rule.
 */
const noCrossFeatureModelImport = {
  meta: {
    type: 'problem',
    docs: {
      description: "Disallow a feature's model code from importing another feature's model code.",
      url: 'https://github.com/dork-labs/dorkos/blob/main/.claude/rules/fsd-layers.md',
    },
    schema: [],
    messages: {
      crossFeatureModel:
        "FSD violation: features/{{own}}/model may not import features/{{other}}'s model " +
        "('{{specifier}}'). Two features' business logic coupling is what this rule stops. " +
        'Reach the sibling through its public barrel — `@/layers/features/{{other}}` — ' +
        'exporting what you need from there, or lift the shared logic to entities/ or shared/.',
    },
  },

  create(context) {
    const own = featureModelOf(context.filename);
    if (own === null) return {};

    /**
     * Report `node` when it names another feature's model.
     *
     * @param node The string literal holding the module path.
     */
    function checkSpecifier(node) {
      if (!node || node.type !== 'Literal' || typeof node.value !== 'string') return;

      const match = FEATURE_MODEL_SPECIFIER.exec(node.value);
      if (match === null || match[1] === own) return;

      context.report({
        node,
        messageId: 'crossFeatureModel',
        data: { own, other: match[1], specifier: node.value },
      });
    }

    return {
      ImportDeclaration: (node) => checkSpecifier(node.source),
      ExportNamedDeclaration: (node) => checkSpecifier(node.source),
      ExportAllDeclaration: (node) => checkSpecifier(node.source),
      ImportExpression: (node) => checkSpecifier(node.source),
    };
  },
};

/** ESLint plugin carrying the client's FSD-specific rules. */
export default {
  meta: { name: 'fsd' },
  rules: {
    'no-cross-slice-relative-import': noCrossSliceRelativeImport,
    'no-cross-feature-model-import': noCrossFeatureModelImport,
  },
};
