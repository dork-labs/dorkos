/**
 * The space server's boundary inside the DorkOS server package (server-merge step 7).
 *
 * The space server's code lives in `src/services/spaces/` but ships alone, in its own image,
 * which must never carry the machine store, a runtime SDK or anything else of the server's.
 * So its code imports only itself, Node's own modules and the packages the space image
 * installs (`apps/community/package.json` `dependencies`), and nothing else in the server
 * imports it. Type-only imports carry no code and are allowed. Tests are not checked: the
 * cross-program conformance tests run the server's code against a real space server on purpose.
 */
import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPACES = resolve(SERVER, 'src/services/spaces');
const BUILTINS = new Set(builtinModules);
/** The packages the space image installs, read from the package it is deployed from. */
const IMAGE_PACKAGES = new Set(
  Object.keys(
    JSON.parse(readFileSync(resolve(SERVER, '../community/package.json'), 'utf8')).dependencies
  )
);

/** Subpaths of allowed packages that still reach what the image must not carry. */
const FORBIDDEN_SUBPATHS = new Set(['@dorkos/shared/node-pty-spawn-helper']);

const inside = (path) => path === SPACES || path.startsWith(SPACES + sep);
const packageOf = (specifier) =>
  specifier
    .split('/')
    .slice(0, specifier.startsWith('@') ? 2 : 1)
    .join('/');

/** Each import, export-from and literal `import()` in a file, with whether it is type-only. */
function importsOf(visit) {
  const each = (node) => {
    if (node.source?.type === 'Literal' && typeof node.source.value === 'string')
      visit(
        node.source,
        node.source.value,
        node.importKind === 'type' || node.exportKind === 'type'
      );
  };
  return {
    ImportDeclaration: each,
    ExportNamedDeclaration: each,
    ExportAllDeclaration: each,
    ImportExpression: each,
  };
}

export default {
  rules: {
    'stay-inside': {
      meta: {
        type: 'problem',
        docs: {
          description: "The space server's code imports only itself and its image's packages.",
        },
        schema: [],
        messages: {
          outside:
            "'{{specifier}}' is outside the space server. Its code ships alone in the space image; import only from src/services/spaces/.",
          package:
            "'{{specifier}}' is not a package the space image installs. Add it to apps/community/package.json dependencies, or keep it out of the space server.",
        },
      },
      create(context) {
        const from = dirname(context.filename);
        return importsOf((node, specifier, typeOnly) => {
          if (typeOnly) return;
          if (specifier.startsWith('.')) {
            if (!inside(resolve(from, specifier)))
              context.report({ node, messageId: 'outside', data: { specifier } });
            return;
          }
          if (specifier.startsWith('node:') || BUILTINS.has(specifier)) return;
          if (FORBIDDEN_SUBPATHS.has(specifier) || !IMAGE_PACKAGES.has(packageOf(specifier)))
            context.report({ node, messageId: 'package', data: { specifier } });
        });
      },
    },
    'no-reach-in': {
      meta: {
        type: 'problem',
        docs: { description: "The DorkOS server never imports the space server's code." },
        schema: [],
        messages: {
          reach:
            "'{{specifier}}' is the space server's code ({{path}}). It runs in its own image; talk to a space over HTTP (services/communities/).",
        },
      },
      create(context) {
        const from = dirname(context.filename);
        return importsOf((node, specifier, typeOnly) => {
          if (typeOnly || !specifier.startsWith('.')) return;
          const target = resolve(from, specifier);
          if (inside(target))
            context.report({
              node,
              messageId: 'reach',
              data: { specifier, path: relative(SERVER, target) },
            });
        });
      },
    },
  },
};
