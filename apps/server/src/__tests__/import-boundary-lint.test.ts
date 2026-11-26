/**
 * The services import boundary (`eslint-rules/import-boundary.js`, DOR-4924): one domain under
 * services/ imports another only along a pair in the baseline, type-only imports and tests are
 * free, and the rule and `check:import-boundary` count the same statements. Linted with the
 * package's real config, so a rule left unwired fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { countFile } from '../../../../scripts/import-boundary/check-import-boundary.js';
import { portLeak } from '../../eslint-rules/import-boundary.js';

const SERVER = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: SERVER });

/** Linting the whole config takes a few seconds on a loaded machine. */
const LINT_TIMEOUT_MS = 30_000;

/** A domain no baseline holds, so every pair it makes is new. */
const NEW_DOMAIN = 'scratch-new-domain';

/** The rule's messages for `code` linted as if it were the file at `path`. */
async function boundary(path: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: `${SERVER}${path}` });
  return result!.messages
    .filter((message) => message.ruleId === 'import-boundary/boundary')
    .map((message) => message.message);
}

/** The pair a refusal names. */
const pairOf = (message: string) => /makes the import (\S+ -> \S+),/u.exec(message)?.[1];

const EDGES = (
  JSON.parse(readFileSync(`${SERVER}eslint-rules/import-boundary.baseline.json`, 'utf8')) as {
    edges: Record<string, number>;
  }
).edges;

/** A file in `domain`, and a specifier from it into `to`, for a pair read from the baseline. */
function planted(from: string, to: string): { path: string; specifier: string } {
  const up = '../'.repeat(from.split('/').length);
  // `core` alone is the files directly in core/; a name that is no folder there lands in it.
  const target = to === 'core' ? 'core/scratch-target.js' : `${to}/index.js`;
  return { path: `src/services/${from}/scratch-example.ts`, specifier: `${up}${target}` };
}

describe('the services import boundary', { timeout: LINT_TIMEOUT_MS }, () => {
  it('refuses a value import that makes a pair the baseline does not hold', async () => {
    // Purpose: fails if a new domain-to-domain import could land unseen.
    const messages = await boundary(
      `src/services/${NEW_DOMAIN}/scratch-example.ts`,
      "import { roomStore } from '../rooms/room-store.js';\nexport const s = roomStore;"
    );
    expect(messages).toEqual([
      `'../rooms/room-store.js' makes the import ${NEW_DOMAIN} -> rooms, which is not in eslint-rules/import-boundary.baseline.json. Imports from one services/ domain into another are deliberate: depend on an interface or port the other domain exports, or move a shared type to packages/shared (type-only imports are allowed). See .claude/rules/server-structure.md.`,
    ]);
  });

  it('allows a pair the baseline holds, a core folder and the files directly in core', async () => {
    // Purpose: fails if an allowlisted pair is refused, or a domain is named the wrong way.
    const pairs = Object.keys(EDGES);
    const picks = [
      pairs[0]!,
      pairs.find((pair) => pair.endsWith(' -> core'))!,
      pairs.find((pair) => /^core\/\S+ -> core\//u.test(pair))!,
    ];
    for (const pair of picks) {
      const [from, to] = pair.split(' -> ') as [string, string];
      const { path, specifier } = planted(from, to);
      const code = `import { x } from '${specifier}';\nexport const y = x;`;
      expect(await boundary(path, code), pair).toEqual([]);
    }
  });

  it('allows every type-only form, and counts a mixed import', async () => {
    // Purpose: fails if a type, which carries no code, were held to the baseline.
    const code = [
      "import type { Room } from '../rooms/room-types.js';",
      "import { type Seat, type Desk } from '../rooms/seats.js';",
      "export type { Plan } from '../tasks/plan.js';",
      "export { type Step } from '../tasks/plan.js';",
      "type Mesh = import('../mesh/index.js').Mesh;",
      "import type relay = require('../relay/index.js');",
      "import { type Run, runNow } from '../runs/index.js';",
      'export type All = [Room, Seat, Desk, Mesh, relay.Relay, Run];',
      'void runNow;',
    ].join('\n');
    const messages = await boundary(`src/services/${NEW_DOMAIN}/scratch-example.ts`, code);
    expect(messages.map(pairOf)).toEqual([`${NEW_DOMAIN} -> runs`]);
  });

  it('exempts tests and fixtures, code outside services, packages and the same domain', async () => {
    // Purpose: fails if the rule matched text instead of resolving paths, or checked a test.
    const reach = "import '../../rooms/x.js';\nimport { y } from '../../tasks/y.js';";
    for (const path of [
      `src/services/${NEW_DOMAIN}/__tests__/scratch-example.test.ts`,
      `src/services/${NEW_DOMAIN}/__fixtures__/scratch-example.ts`,
      `src/services/${NEW_DOMAIN}/sub/scratch-example.spec.ts`,
    ]) {
      expect(await boundary(path, reach), path).toEqual([]);
    }
    expect(
      await boundary('src/routes/scratch-example.ts', "import '../services/rooms/x.js';")
    ).toEqual([]);
    const inside = [
      `import { a } from './sub/a.js';`,
      `import { b } from '../${NEW_DOMAIN}/b.js';`,
      `import { c } from '../../lib/dork-home.js';`,
      "import { z } from 'zod';",
    ].join('\n');
    expect(await boundary(`src/services/${NEW_DOMAIN}/scratch-example.ts`, inside)).toEqual([]);
  });

  it('counts every value form, and the checker counts the same pairs (a planted tree)', async () => {
    // Purpose: fails if the rule and `check:import-boundary` could count one file differently.
    // Every pair here is new, so the rule reports each statement the checker counts.
    const tree: Record<string, string> = {
      [`src/services/${NEW_DOMAIN}/forms.ts`]: [
        "import '../rooms/side-effect.js';",
        "export * from '../mesh/index.js';",
        "export { listTasks } from '../tasks/list.js';",
        "import relay = require('../relay/index.js');",
        "export const later = () => import('../runs/index.js');",
        "declare module '../session/types.js' { interface Extra { seat: string } }",
        "import Default, { type Only } from '../memory/index.js';",
        'export const dyn = (name: string) => import(`../todos/${name}.js`);',
        "import type { T } from '../todos/types.js';",
        'void relay; void Default; export type O = [Only, T];',
      ].join('\n'),
      'src/services/core/scratch-folder/deep/file.ts': [
        "import { a } from '../../config-manager.js';",
        "import { b } from '../../turn-power/index.js';",
        "import { c } from '../sibling.js';",
        'export { a, b, c };',
      ].join('\n'),
    };
    const counts: Record<string, Record<string, number>> = {};
    for (const [path, code] of Object.entries(tree)) {
      counts[path] = countFile(`${SERVER}${path}`, code);
      const linted = (await boundary(path, code)).map(pairOf).sort();
      const counted = Object.entries(counts[path]!)
        .flatMap(([pair, n]) => Array.from({ length: n }, () => pair))
        .sort();
      expect(linted, path).toEqual(counted);
    }
    // Seven statements carry code; the template-literal `import()` names no module.
    expect(counts[`src/services/${NEW_DOMAIN}/forms.ts`]).toEqual(
      Object.fromEntries(
        ['memory', 'mesh', 'relay', 'rooms', 'runs', 'session', 'tasks'].map((to) => [
          `${NEW_DOMAIN} -> ${to}`,
          1,
        ])
      )
    );
    // A folder under core/ is its own domain; a file directly in core/ is in `core`.
    expect(counts['src/services/core/scratch-folder/deep/file.ts']).toEqual({
      'core/scratch-folder -> core': 1,
      'core/scratch-folder -> core/turn-power': 1,
    });
  });
});

describe('ports and composition roots', { timeout: LINT_TIMEOUT_MS }, () => {
  const from = `src/services/${NEW_DOMAIN}/scratch-example.ts`;
  const PORT = 'src/services/core/capabilities/capability-definition.ts';
  const ROOT = 'src/services/core/self-description/dorkos-registry.ts';

  it('does not count an import into the port', async () => {
    // Purpose: fails if every domain declaring a capability were counted as coupling.
    const code =
      "import { defineCapability } from '../core/capabilities/capability-definition.js';\nexport const d = defineCapability;";
    expect(await boundary(from, code)).toEqual([]);
    expect(countFile(`${SERVER}${from}`, code)).toEqual({});
  });

  it("still counts anything else in the port's folder", async () => {
    // Purpose: fails if the port widened to its whole domain.
    const code =
      "import { CapabilityToolError } from '../core/capabilities/mcp-envelope.js';\nexport const e = CapabilityToolError;";
    expect((await boundary(from, code)).map(pairOf)).toEqual([
      `${NEW_DOMAIN} -> core/capabilities`,
    ]);
  });

  it("still counts a domain importing the composition root, but not the root's own imports", async () => {
    // Purpose: fails if the root's exemption ran both ways.
    const into =
      "import { registry } from '../core/self-description/dorkos-registry.js';\nexport const r = registry;";
    expect((await boundary(from, into)).map(pairOf)).toEqual([
      `${NEW_DOMAIN} -> core/self-description`,
    ]);
    const out = `import { x } from '../../${NEW_DOMAIN}/scratch.js';\nexport const y = x;`;
    expect(await boundary(ROOT, out)).toEqual([]);
    expect(countFile(`${SERVER}${ROOT}`, out)).toEqual({});
  });

  it('refuses a port that imports a domain', async () => {
    // Purpose: fails if a port could stop being a leaf and pull its importers along.
    const code =
      "import { roomStore } from '../../rooms/room-store.js';\nexport const s = roomStore;";
    const messages = await boundary(PORT, code);
    expect(messages).toContainEqual(
      expect.stringContaining('core/capabilities -> rooms from a port')
    );
    expect(portLeak(`${SERVER}${PORT}`, '../../rooms/room-store.js')).toBe(
      'core/capabilities -> rooms'
    );
    expect(portLeak(`${SERVER}${PORT}`, './registry.js')).toBeNull();
  });
});
