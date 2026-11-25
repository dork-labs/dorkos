/**
 * The turn port's ratchet (spec `turns-survive-restarts` §3.4, DOR-5157): the space side reaches
 * turn code through the turn port and nothing else, and the imports that do not yet may only go.
 *
 * - **Turn code** is `src/services/session/**` except `session/chat-messages/**` (space-side by
 *   `contributing/architecture-target.md` §3), plus `src/services/runtimes/**`.
 * - **The space-side domains** under the rule are the fourteen of §3.4. `routes/` and
 *   `services/core/` join when DOR-4921 sorts `core` into sides.
 * - A file in a space-side domain imports nothing from turn code, type-only imports included (a
 *   type the space side needs belongs in `packages/shared`), beyond what its entry in
 *   `turn-port-boundary.baseline.json` still allows. An entry may only fall: a file with fewer
 *   imports than its entry fails too, until `pnpm check:turn-port -- --update` lowers it.
 * - `src/services/runs` imports only `services/session/turn-port/index.js` from turn code, and
 *   turn code imports nothing from `src/services/runs`. Neither has a baseline.
 *
 * Every specifier is resolved against the file, never matched as text, so `tasks/session/` (not
 * turn code) is not counted and a path spelled another way is. Tests are not checked. The
 * baseline's own rules (no entry raised or added by hand) are `scripts/turn-port/check-turn-port-boundary.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importsOf } from './space-boundary.js';

const SERVER = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(SERVER, 'src');

/** The baseline file, relative to the server package. */
export const BASELINE_FILE = 'eslint-rules/turn-port-boundary.baseline.json';

/** The fourteen space-side domains the rule holds (§3.4). */
export const SPACE_DOMAINS = [
  'rooms',
  'tasks',
  'heartbeats',
  'canvas',
  'extensions',
  'connectors',
  'relay',
  'mesh',
  'todos',
  'work-queue',
  'notifications',
  'audit',
  'activity',
  'search',
];

/** The one turn-code module `services/runs` may import: the computer face's barrel. */
const PORT_DOOR = 'services/session/turn-port';

/** A path relative to `src/`, with `/` separators, no extension and no trailing `/index`. */
function inSrc(path) {
  return relative(SRC, path)
    .split(sep)
    .join('/')
    .replace(/\.(?:[cm]?js|tsx?)$/u, '');
}

/**
 * Which side of the port a file is on.
 *
 * @param {string} file - An absolute path.
 * @returns {'space' | 'runs' | 'turn' | 'other'}
 */
export function sideOf(file) {
  const rel = inSrc(file);
  const [top, domain] = rel.split('/');
  if (top !== 'services' || domain === undefined) return 'other';
  if (domain === 'runs') return 'runs';
  if (domain === 'runtimes') return 'turn';
  if (domain === 'session') {
    return rel === 'services/session/chat-messages' ||
      rel.startsWith('services/session/chat-messages/')
      ? 'other'
      : 'turn';
  }
  return SPACE_DOMAINS.includes(domain) ? 'space' : 'other';
}

/**
 * Whether one import crosses the port the wrong way, and which rule it breaks.
 *
 * @param {string} file - The importing file, absolute.
 * @param {string} specifier - The import's specifier, as written.
 * @returns {'space' | 'runs' | 'turn' | null} `space`: a space-side file reaching turn code;
 *   `runs`: the run record reaching past the port's door; `turn`: turn code reaching the run
 *   record. `null` for every other import.
 */
export function crossing(file, specifier) {
  if (!specifier.startsWith('.')) return null;
  const target = resolve(dirname(file), specifier);
  const from = sideOf(file);
  const to = sideOf(target);
  if (from === 'space' && to === 'turn') return 'space';
  if (from === 'runs' && to === 'turn' && inSrc(target).replace(/\/index$/u, '') !== PORT_DOOR) {
    return 'runs';
  }
  if (from === 'turn' && to === 'runs') return 'turn';
  return null;
}

/**
 * The baseline's entries: a file, relative to the server package, to the imports of turn code it
 * may still hold.
 *
 * @returns {Record<string, number>}
 */
export function readBaseline() {
  return JSON.parse(readFileSync(resolve(SERVER, BASELINE_FILE), 'utf8')).files;
}

const BASELINE = readBaseline();

export default {
  rules: {
    boundary: {
      meta: {
        type: 'problem',
        docs: { description: 'The space side reaches turn code through the turn port only.' },
        schema: [],
        messages: {
          space:
            "'{{specifier}}' is turn code. A space-side domain starts, watches and stops turns through the turn port (services/runs), and a type it needs belongs in packages/shared. This file has {{count}} such imports; its baseline allows {{allowed}}.",
          stale:
            'This file has {{count}} imports of turn code and its baseline allows {{allowed}}. Lock the drop in: pnpm check:turn-port -- --update.',
          runs: "'{{specifier}}' is turn code. services/runs reaches it only through services/session/turn-port/index.js.",
          turn: "'{{specifier}}' is the run record. Turn code reports to it through the facts sink (services/session/turn-port/facts.ts) and never imports it.",
        },
      },
      create(context) {
        const file = context.filename;
        if (sideOf(file) === 'other') return {};
        const found = [];
        return {
          ...importsOf((node, specifier) => {
            const kind = crossing(file, specifier);
            if (kind) found.push({ node, specifier, kind });
          }),
          'Program:exit'(program) {
            const spaceSide = found.filter((hit) => hit.kind === 'space');
            for (const hit of found) {
              if (hit.kind !== 'space')
                context.report({
                  node: hit.node,
                  messageId: hit.kind,
                  data: { specifier: hit.specifier },
                });
            }
            const allowed = BASELINE[relative(SERVER, file).split(sep).join('/')] ?? 0;
            const count = spaceSide.length;
            if (count > allowed) {
              for (const hit of spaceSide)
                context.report({
                  node: hit.node,
                  messageId: 'space',
                  data: { specifier: hit.specifier, count, allowed },
                });
            } else if (count < allowed) {
              context.report({ node: program, messageId: 'stale', data: { count, allowed } });
            }
          },
        };
      },
    },
  },
};
