/**
 * The session domain is the turn code the runtimes plug into, so it never imports them
 * (DOR-4928, `contributing/architecture-target.md`): the runtimes import session, and the
 * reverse edge made the two one tangle. A piece both need lives on the session side, or
 * outside both (`services/core`); a fact only an adapter knows reaches session through a
 * registered port (`session/resolution/claude-code-facts.ts`) or the runtime object itself.
 * Every import form counts, type-only ones included: the forms `importsOf` sees, plus a type
 * written as `import('…')` and `import x = require('…')`. Tests are not checked: they wire
 * real runtimes on purpose.
 */
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsOf } from './space-boundary.js';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUNTIMES = resolve(SERVER, 'src/services/runtimes');

const inside = (path) => path === RUNTIMES || path.startsWith(RUNTIMES + sep);

/** The string literal a type-position `import('…')` names (`source` in typescript-eslint 8). */
const importTypeSource = (node) => node.source ?? node.argument?.literal;

export default {
  rules: {
    'no-runtimes': {
      meta: {
        type: 'problem',
        docs: { description: 'Session code never imports services/runtimes.' },
        schema: [],
        messages: {
          reach:
            "'{{specifier}}' is runtime code ({{path}}). Session code is what the runtimes build on: move a shared piece to session or core, or take an adapter's answer through a port (see session/resolution/claude-code-facts.ts).",
        },
      },
      create(context) {
        const from = dirname(context.filename);
        const check = (node, specifier) => {
          if (typeof specifier !== 'string' || !specifier.startsWith('.')) return;
          const target = resolve(from, specifier);
          if (inside(target))
            context.report({
              node,
              messageId: 'reach',
              data: { specifier, path: relative(SERVER, target) },
            });
        };
        const literal = (node) => {
          if (node?.type === 'Literal') check(node, node.value);
        };
        return {
          ...importsOf(check),
          TSImportType: (node) => literal(importTypeSource(node)),
          TSExternalModuleReference: (node) => literal(node.expression),
        };
      },
    },
  },
};
