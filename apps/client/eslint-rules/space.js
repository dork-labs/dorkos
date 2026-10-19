/**
 * The app and the space's own website share a package but are two sites (server-merge step 7e).
 * `src/space/` is the space's website, built by `vite.space.config.ts` and served by the space
 * server; everything else in `src/` is the app. Neither imports the other, so neither build can
 * pull the other in: shared code goes through `@dorkos/shared` or `@dork-labs/ui`.
 */
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');
const SPACE = resolve(SRC, 'space');
const inSpace = (path) => path === SPACE || path.startsWith(SPACE + sep);

export default {
  rules: {
    'separate-sites': {
      meta: {
        type: 'problem',
        docs: { description: "The app and the space's website never import each other." },
        schema: [],
        messages: {
          intoSpace:
            "'{{specifier}}' is the space's own website (src/space). Share code through @dorkos/shared.",
          outOfSpace:
            "'{{specifier}}' is the app's code. The space's website shares only through @dorkos/shared or @dork-labs/ui.",
        },
      },
      create(context) {
        const from = dirname(context.filename);
        const fromSpace = inSpace(context.filename);
        const check = (node) => {
          const specifier = node.source?.value;
          if (typeof specifier !== 'string') return;
          let target = null;
          if (specifier.startsWith('.')) target = resolve(from, specifier);
          else if (specifier === '@' || specifier.startsWith('@/'))
            target = resolve(SRC, specifier.slice(2));
          if (target === null) return;
          if (fromSpace && !inSpace(target))
            context.report({ node: node.source, messageId: 'outOfSpace', data: { specifier } });
          if (!fromSpace && inSpace(target))
            context.report({ node: node.source, messageId: 'intoSpace', data: { specifier } });
        };
        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ImportExpression: check,
        };
      },
    },
  },
};
