/**
 * The work graph stays on the space side of the space/computer cut (ADR 261124-131941,
 * ADR 261122-173853). Its edges are space data, so turn code (the runtimes and the session
 * domain) hands it facts through hooks or events and never imports it: that keeps its move
 * to the space store (DOR-5139) a store move, not a rewrite. Every import form counts,
 * type-only ones included, and tests are checked too.
 */
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsOf } from './space-boundary.js';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WORK_GRAPH = resolve(SERVER, 'src/services/work-graph');

const inside = (path) => path === WORK_GRAPH || path.startsWith(WORK_GRAPH + sep);

export default {
  rules: {
    'stay-out': {
      meta: {
        type: 'problem',
        docs: { description: 'Runtime and session code never imports the work graph.' },
        schema: [],
        messages: {
          reach:
            "'{{specifier}}' is the work graph ({{path}}), which is space data. Turn code hands it facts through a hook or an event (see session/turn-identity/durable-rekey.ts).",
        },
      },
      create(context) {
        const from = dirname(context.filename);
        return importsOf((node, specifier) => {
          if (!specifier.startsWith('.')) return;
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
