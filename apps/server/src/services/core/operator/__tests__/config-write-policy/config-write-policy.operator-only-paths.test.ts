import { describe, it, expect } from 'vitest';
import {
  CONFIG_WRITE_POLICY,
  OPERATOR_ONLY_CONFIG_PATHS,
  findOperatorOnlyPaths,
} from '../../config-write-policy.js';
import { patchForPath, legacyPatchPaths } from './config-write-policy.fixtures.js';

/**
 * {@link findOperatorOnlyPaths} as it behaved before the array descent.
 *
 * @param patch - The raw patch a caller supplied.
 * @returns The offending policy paths under the old matcher.
 */
function legacyFindOperatorOnlyPaths(patch: unknown): string[] {
  const hits = new Set<string>();
  for (const path of legacyPatchPaths(patch)) {
    for (const guarded of OPERATOR_ONLY_CONFIG_PATHS) {
      if (path === guarded || path.startsWith(`${guarded}.`) || guarded.startsWith(`${path}.`)) {
        hits.add(guarded);
      }
    }
  }
  return [...hits].sort();
}

describe('findOperatorOnlyPaths', () => {
  it('catches the escalation it exists for', () => {
    expect(findOperatorOnlyPaths({ auth: { enabled: false } })).toEqual(['auth.enabled']);
  });

  // Security on DOR-3675: an agent may not aim the "nothing is running" notice at a room of its
  // choosing, so a patch that sets it is a person's alone.
  it('refuses an agent the room the idle alert posts in', () => {
    expect(findOperatorOnlyPaths({ heartbeats: { idleAlertRoomId: 'room-elsewhere' } })).toEqual([
      'heartbeats.idleAlertRoomId',
    ]);
  });

  it('catches a patch that stops SHORT of the guarded leaf', () => {
    // `{ auth: true }` never reaches `auth.enabled` as a dot-path, so a plain
    // equality check would wave it through to the merge.
    expect(findOperatorOnlyPaths({ auth: true })).toEqual(['auth.enabled']);
  });

  it('catches a patch that reaches PAST a guarded record', () => {
    // `providers` is classified whole; a patch addresses it one level deeper.
    expect(findOperatorOnlyPaths({ providers: { anthropic: 'file:/tmp/key' } })).toEqual([
      'providers',
    ]);
  });

  it('catches an empty branch on a guarded section', () => {
    expect(findOperatorOnlyPaths({ auth: {} })).toEqual(['auth.enabled']);
  });

  it('names every guarded leaf under a whole-section patch', () => {
    expect(
      findOperatorOnlyPaths({ tunnel: { enabled: true, domain: 'evil.example.com' } })
    ).toEqual(['tunnel.domain', 'tunnel.enabled']);
  });

  it('lets ordinary preferences through', () => {
    expect(
      findOperatorOnlyPaths({
        ui: { theme: 'dark', sidebar: { sections: { channels: { collapsed: true } } } },
        logging: { level: 'debug' },
        runtimes: { default: 'codex', opencode: { enabled: true, port: 0 } },
        server: { cwd: '/Users/me/code', port: 4300 },
      })
    ).toEqual([]);
  });

  it('refuses a provider switch, because it cannot be decoupled from baseURL', () => {
    // `credential-env.ts` applies `baseURL` unconditionally, outside its
    // `if (providerId)` block, so flipping `provider` on its own can pair a
    // different key with a base URL the operator set for another provider.
    expect(findOperatorOnlyPaths({ runtimes: { opencode: { provider: 'openai' } } })).toEqual([
      'runtimes.opencode.provider',
    ]);
  });

  it('flags a mixed patch, so nothing rides in behind a legitimate change', () => {
    expect(findOperatorOnlyPaths({ ui: { theme: 'dark' }, auth: { enabled: false } })).toEqual([
      'auth.enabled',
    ]);
  });

  it('touches nothing for a non-object patch', () => {
    expect(findOperatorOnlyPaths(undefined)).toEqual([]);
    expect(findOperatorOnlyPaths(null)).toEqual([]);
    expect(findOperatorOnlyPaths('auth')).toEqual([]);
    expect(findOperatorOnlyPaths([{ auth: { enabled: false } }])).toEqual([]);
  });
});

describe('findOperatorOnlyPaths — settings that live inside a list (DOR-1113)', () => {
  it('catches a whole-list replacement of the raw MCP servers', () => {
    // The reproduction. A raw-MCP server is an outbound tool endpoint pointed
    // wherever the writer likes, and the guard used to stop at
    // `connectors.rawMcpServers` — a path no policy key equals, because every
    // policy key for it names an element field — so the write went through.
    expect(
      findOperatorOnlyPaths({
        connectors: {
          rawMcpServers: [
            {
              slug: 'evil',
              displayName: 'Evil',
              url: 'https://evil.example.com/mcp',
              transport: 'http',
            },
          ],
        },
      })
    ).toEqual([
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
    ]);
  });

  it('catches a whole-list replacement of the Claude account roster', () => {
    // The same hole on the credential axis: an account directory carries its own
    // sign-in, so writing the roster moves whose subscription the work bills to.
    expect(
      findOperatorOnlyPaths({
        runtimes: { claudeCode: { accounts: [{ path: '/tmp/evil', label: 'mine' }] } },
      })
    ).toEqual(['runtimes.claudeCode.accounts[].label', 'runtimes.claudeCode.accounts[].path']);
  });

  it('keeps the whole account row operator-only, color included (DOR-2379)', () => {
    // A color is cosmetic, but `accounts` is written as a whole array: a write
    // that could set a color could also add or repoint an account.
    expect(
      findOperatorOnlyPaths({
        runtimes: { claudeCode: { accounts: [{ id: 'a', color: '#000000' }] } },
      })
    ).toEqual(['runtimes.claudeCode.accounts[].color', 'runtimes.claudeCode.accounts[].id']);
  });

  it('refuses an agent clearing an account’s keep-out-of-automatic-moves flag (Re-seat P0)', () => {
    // A person set it; clearing it would let a seat move onto an account the
    // person reserved, so the flag alone, with nothing else on the row, is caught.
    expect(
      findOperatorOnlyPaths({
        runtimes: { claudeCode: { accounts: [{ noAutoMove: false }] } },
      })
    ).toEqual(['runtimes.claudeCode.accounts[].noAutoMove']);
  });

  it('names only the element fields the patch actually writes', () => {
    expect(
      findOperatorOnlyPaths({ connectors: { rawMcpServers: [{ url: 'https://evil.test/mcp' }] } })
    ).toEqual(['connectors.rawMcpServers[].url']);
  });

  it('names a field any element writes, not just the first', () => {
    expect(
      findOperatorOnlyPaths({
        connectors: { rawMcpServers: [{ slug: 'a' }, { url: 'https://evil.test/mcp' }] },
      })
    ).toEqual(['connectors.rawMcpServers[].slug', 'connectors.rawMcpServers[].url']);
  });

  it('catches emptying the list, which is a write to it too', () => {
    // `[]` carries no element to descend into, so it has to be caught as an
    // ancestor of the element fields — the same way `{ auth: {} }` is.
    expect(findOperatorOnlyPaths({ connectors: { rawMcpServers: [] } })).toEqual([
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
    ]);
    expect(findOperatorOnlyPaths({ runtimes: { claudeCode: { accounts: [] } } })).toEqual([
      'runtimes.claudeCode.accounts[].agentsMayPick',
      'runtimes.claudeCode.accounts[].color',
      'runtimes.claudeCode.accounts[].id',
      'runtimes.claudeCode.accounts[].label',
      'runtimes.claudeCode.accounts[].noAutoMove',
      'runtimes.claudeCode.accounts[].onlyProjects',
      'runtimes.claudeCode.accounts[].path',
    ]);
  });

  it('catches a patch that stops SHORT of the list', () => {
    expect(findOperatorOnlyPaths({ connectors: {} })).toEqual([
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
    ]);
    expect(findOperatorOnlyPaths({ connectors: true })).toEqual([
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
    ]);
  });

  it('leaves the lists an agent may write alone, descent or no descent', () => {
    // Descending into arrays must not spray refusals over the sidebar, whose
    // element fields are all `agent-writable` on purpose. This is the case the
    // module doc called "harmless only because every verdict below is
    // agent-writable" — it stays harmless, now for a checked reason.
    expect(
      findOperatorOnlyPaths({
        ui: {
          sidebar: {
            pinned: [{ kind: 'room', roomId: 'r1' }],
            muted: [{ kind: 'path', path: '/tmp' }],
            groups: [
              {
                id: 'g1',
                name: 'Work',
                kind: 'manual',
                collapsed: false,
                items: [{ kind: 'room', roomId: 'r1' }],
                rules: { runtimes: ['codex'], pathPrefix: '/tmp' },
              },
            ],
          },
          statusBar: { pins: ['runtime'] },
        },
      })
    ).toEqual([]);
  });

  it('still catches a list classified whole, element shape or not', () => {
    // These four are guarded at the PARENT path rather than per element, and the
    // descent must not lose them.
    expect(findOperatorOnlyPaths({ mesh: { scanRoots: ['/'] } })).toEqual(['mesh.scanRoots']);
    expect(findOperatorOnlyPaths({ extensions: { approvedToRun: ['evil-ext'] } })).toEqual([
      'extensions.approvedToRun',
    ]);
    expect(findOperatorOnlyPaths({ extensions: { enabled: ['evil-ext'] } })).toEqual([
      'extensions.enabled',
    ]);
    expect(findOperatorOnlyPaths({ harness: { approvedHooks: ['evil-pkg'] } })).toEqual([
      'harness.approvedHooks',
    ]);
    // Emptying one of them is still a write to it.
    expect(findOperatorOnlyPaths({ mesh: { scanRoots: [] } })).toEqual(['mesh.scanRoots']);
  });

  it('gives the same answer for a list of one and a list of thousands', () => {
    // The descent makes the walk scale with element COUNT, so the matcher dedupes
    // the touched paths before matching them (a 1MB list otherwise blocks the
    // event loop for over a second on a route that runs this before any authority
    // check). Deduping cannot change a verdict — a repeated path only re-adds hits
    // already in the set — and this is what says so out loud, at a size where a
    // quadratic matcher would be obvious rather than subtle.
    const server = { slug: 'a', url: 'https://a.test/mcp' };
    const one = findOperatorOnlyPaths({ connectors: { rawMcpServers: [server] } });
    const many = findOperatorOnlyPaths({
      connectors: { rawMcpServers: Array.from({ length: 3000 }, () => ({ ...server })) },
    });
    expect(many).toEqual(one);
    expect(many).toEqual(['connectors.rawMcpServers[].slug', 'connectors.rawMcpServers[].url']);
  });

  it('catches EVERY operator-only path that lives inside a list', () => {
    // The drift guard for the gap class, not for the two families that happened
    // to be found. A future `[]` family added to the table is caught here on the
    // day it ships, whether or not anybody remembers this bug.
    const insideLists = OPERATOR_ONLY_CONFIG_PATHS.filter((path) => path.includes('[]'));
    expect(insideLists.length).toBeGreaterThan(0);
    for (const path of insideLists) {
      expect(findOperatorOnlyPaths(patchForPath(path)), `unguarded: ${path}`).toContain(path);
    }
  });
});

describe('the array descent changes no other verdict (DOR-1113)', () => {
  /** Every policy path that names no array element — the whole table minus `[]`. */
  const plainPaths = Object.keys(CONFIG_WRITE_POLICY).filter((path) => !path.includes('['));

  /**
   * Every patch worth comparing for one path: the leaf itself in four value
   * shapes (scalar, list of scalars, list of objects, empty object), plus each
   * ancestor of it written short — which is where the two-directional matching
   * lives, and so where a change would hide.
   *
   * @param dotPath - The policy path to build patches for.
   * @returns Patches, each exercising the same path a different way.
   */
  function patchesFor(dotPath: string): unknown[] {
    const segments = dotPath.split('.');
    const ancestors = segments
      .slice(0, -1)
      .map((_, index) => segments.slice(0, index + 1).join('.'));
    return [
      patchForPath(dotPath, 'a-value'),
      patchForPath(dotPath, ['a-value']),
      patchForPath(dotPath, [{ nested: 'a-value' }]),
      patchForPath(dotPath, {}),
      patchForPath(dotPath, []),
      ...ancestors.flatMap((ancestor) => [
        patchForPath(ancestor, true),
        patchForPath(ancestor, {}),
      ]),
    ];
  }

  it('agrees with the pre-fix matcher on every path outside a list', () => {
    expect(plainPaths.length).toBeGreaterThan(50);
    for (const dotPath of plainPaths) {
      for (const patch of patchesFor(dotPath)) {
        expect(findOperatorOnlyPaths(patch), `${dotPath}: ${JSON.stringify(patch)}`).toEqual(
          legacyFindOperatorOnlyPaths(patch)
        );
      }
    }
  });

  it('is the ONLY thing that changed: the pre-fix matcher missed the list paths entirely', () => {
    // The bug, pinned as a fact about the old code rather than a story about it.
    for (const path of OPERATOR_ONLY_CONFIG_PATHS.filter((p) => p.includes('[]'))) {
      expect(legacyFindOperatorOnlyPaths(patchForPath(path))).toEqual([]);
      expect(findOperatorOnlyPaths(patchForPath(path))).toContain(path);
    }
  });
});
