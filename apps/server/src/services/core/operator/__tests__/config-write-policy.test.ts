/**
 * Drift guard + matching tests for the agent-facing config WRITE allowlist.
 *
 * `operator.config_patch` is tier `act`, so nothing asks a person before it runs.
 * What it may write therefore has to be a deliberate classification rather than
 * "everything the schema accepts". The guard here is the point of this file: it
 * compares {@link CONFIG_WRITE_POLICY} against the leaves of the live
 * `UserConfigSchema` in **both** directions, so adding, renaming, or removing a
 * config field fails until someone gives it a verdict. That is the same shape as
 * the read-side guard in `config-disclosure.test.ts`, and it exists for the same
 * reason: a hand-maintained denylist passes silently in exactly the case that
 * matters, which is how a posture-bearing field becomes agent-writable by
 * accident.
 *
 * @vitest-environment node
 */
import { describe, it, expect } from 'vitest';
import { configSchemaLeafPaths } from '../config-disclosure.js';
import { PROTECTIVE_CARRYOVERS } from '../../safe-defaults/protected-state.js';
import {
  CONFIG_WRITE_POLICY,
  OPERATOR_ONLY_CONFIG_PATHS,
  OPERATOR_ONLY_STAKES,
  REQUIRES_LOGIN_CONFIG_PATHS,
  findLoginRequiredPaths,
  findOperatorOnlyPaths,
  describeOperatorOnlyRefusal,
} from '../config-write-policy.js';

describe('CONFIG_WRITE_POLICY drift guard', () => {
  it('classifies every leaf of UserConfigSchema', () => {
    // Direction A: a newly added config field must not become agent-writable
    // just by existing. The failure names the offenders so the fix is "add a
    // verdict", not "go hunting".
    const unclassified = configSchemaLeafPaths().filter((p) => !(p in CONFIG_WRITE_POLICY));
    expect(unclassified).toEqual([]);
  });

  it('classifies nothing that is not a leaf of UserConfigSchema', () => {
    // Direction B: a renamed or removed field must not leave a stale verdict
    // behind, which would silently stop covering the field that replaced it.
    const schemaLeaves = new Set(configSchemaLeafPaths());
    const stale = Object.keys(CONFIG_WRITE_POLICY).filter((p) => !schemaLeaves.has(p));
    expect(stale).toEqual([]);
  });

  it('holds exactly this set of operator-only settings', () => {
    // The classification itself is asserted, not just the behavior: this is the
    // list a reviewer reads. Moving any of these to `agent-writable` is a
    // security decision and has to break a test.
    expect([...OPERATOR_ONLY_CONFIG_PATHS].sort()).toEqual([
      // Mounting the external A2A surface is a reach decision, not a preference:
      // it publishes a card describing every agent here and opens an address
      // outside clients post work to (DOR-1304).
      'a2a.enabled',
      // The four tool-group switches. Carried across a config wipe, so the
      // wipe floor makes them operator-only: an agent could otherwise undo a
      // narrowing the person made to its own tool groups (DOR-1497). They feed
      // the context blocks rather than tool access — see the module doc.
      'agentContext.adapterTools',
      'agentContext.meshTools',
      'agentContext.relayTools',
      'agentContext.tasksTools',
      'agents.defaultDirectory',
      'approvals.standingGrants',
      'approvals.standingGrantsVoidBefore',
      'approvals.trustWindowMinutes',
      'auth.enabled',
      'cloud.instanceName',
      'cloud.instanceToken',
      'cloud.linkedAccountLabel',
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
      'extensions.approvedToRun',
      'extensions.disabled',
      'extensions.enabled',
      'harness.approvedHooks',
      'harness.autoSync',
      'mcp.apiKey',
      'mcp.enabled',
      'mcp.rateLimit.enabled',
      'mcp.rateLimit.maxPerWindow',
      'mcp.rateLimit.windowSecs',
      // Which backend holds what every agent on this machine remembers (spec
      // `agent-memory`, D7). One write moves every agent's notes somewhere the
      // operator did not choose, and memory is the one store an agent writes to
      // itself.
      'memory.provider',
      'mesh.scanRoots',
      // Every way the operator finds out something is waiting on them. An agent
      // able to write these could silence its own alarm and then park on a
      // question nobody is told about (spec `notification-system`, DOR-1385).
      'notifications.browserPermissionPrimerDismissed',
      'notifications.escalation.phoneAfterMinutes',
      'notifications.notifyOnTurnCompleteWhileAway',
      'notifications.sounds.allClear',
      'notifications.sounds.knock',
      'notifications.sounds.turnEnd',
      'providers',
      'relay.dataDir',
      'rooms.collectDebounceMs',
      'rooms.collectMaxEntries',
      'rooms.engagedWindowMinutes',
      'rooms.engagedWindowPosts',
      'rooms.maxAgentDepth',
      'rooms.maxAutomaticTurnsPerRoomPerHour',
      'rooms.maxAutomaticTurnsTotalPerHour',
      'rooms.maxTurnsPerAgentPerCascade',
      // A room's own files: whether they exist at all, and the bounds a merge
      // is measured against. `rooms.repo.mergeQueueWaitMs` is deliberately NOT
      // here — waiting longer for a queued merge buys no file and no byte.
      'rooms.repo.enabled',
      'rooms.repo.maxFileBytes',
      'rooms.repo.maxRepoBytes',
      'rooms.repo.maxRoomMdBytes',
      'rooms.repo.worktreeReapDays',
      'rooms.responseGate',
      'rooms.turnLimitsEnabled',
      'runtimes.claudeCode.accounts[].id',
      'runtimes.claudeCode.accounts[].label',
      'runtimes.claudeCode.accounts[].path',
      'runtimes.claudeCode.defaultAccount',
      'runtimes.claudeCode.defaultTrustStop',
      // Not for the reason its neighbours are here: warm sessions are
      // safety-neutral and cost memory. It is the wipe floor — a person who
      // turned it off wanted the gigabyte back, and the Control Center's 'Warm
      // agents' switch is where they say so (DOR-1497).
      'runtimes.claudeCode.persistentSession',
      'runtimes.codex.binaryPath',
      'runtimes.codex.credentialRef',
      'runtimes.codex.defaultTrustStop',
      'runtimes.defaultTrustStop',
      'runtimes.opencode.baseURL',
      'runtimes.opencode.binaryPath',
      'runtimes.opencode.defaultTrustStop',
      'runtimes.opencode.provider',
      'scheduler.maxConcurrentRuns',
      'server.boundary',
      'telemetry.aiMetadata',
      'telemetry.errorReporting',
      'telemetry.heartbeat',
      'telemetry.install',
      'telemetry.lastPromptedVersion',
      'telemetry.linkAnalyticsToAccount',
      'telemetry.usage',
      'telemetry.userHasDecided',
      'tunnel.auth',
      'tunnel.authtoken',
      'tunnel.domain',
      'tunnel.enabled',
      'ui.autonomyAcknowledgedAt',
      'ui.fullPowerChoice',
      'ui.fullPowerDecidedAt',
      // Two bounds a person can tighten past the shipped default. `allowedTypes`
      // is NOT here: it is narrowable too, but carries no carryover rule, so the
      // wipe floor does not reach it and moving it would be a fresh judgement.
      'uploads.maxFileSize',
      'uploads.maxFiles',
      'welcomeBack.absenceThresholdMinutes',
      'welcomeBack.enabled',
      'welcomeBack.maxPosts',
      'welcomeBack.offersEnabled',
      'workspace.rootPath',
    ]);
  });

  it('stays unambiguous once the `[]` markers come off', () => {
    // The matcher compares paths with their array markers stripped (DOR-1113),
    // which is only safe while no two policy keys collapse onto the same plain
    // path — a collision would file one field's verdict under another's name.
    // Nothing in the schema can produce one (a field is an array of objects or
    // an object, never both), so this asserts the property rather than trusting
    // it: a `foo[].bar` added beside an existing `foo.bar` goes red here.
    const plain = Object.keys(CONFIG_WRITE_POLICY).map((path) => path.replaceAll('[]', ''));
    const seen = new Set<string>();
    const collisions = plain.filter((path) => (seen.has(path) ? true : (seen.add(path), false)));
    expect(collisions).toEqual([]);
  });

  it('withholds from writing everything it also withholds from reading', () => {
    // A field too sensitive to show an untrusted caller is certainly too
    // sensitive for that caller to overwrite. Asserted rather than assumed, so
    // the two tables cannot drift apart in the direction that matters.
    const secretsAndReferences = [
      'tunnel.authtoken',
      'tunnel.auth',
      'mcp.apiKey',
      'cloud.instanceToken',
      'cloud.linkedAccountLabel',
      'runtimes.codex.credentialRef',
      'providers',
    ];
    for (const dotPath of secretsAndReferences) {
      expect(CONFIG_WRITE_POLICY[dotPath as keyof typeof CONFIG_WRITE_POLICY]).toBe(
        'operator-only'
      );
    }
  });
});

describe('the wipe floor: the write policy is at least as protective as recovery (DOR-1497)', () => {
  it('refuses an agent every leaf a config wipe refuses to reverse', () => {
    // The invariant, stated once. `PROTECTIVE_CARRYOVERS` is the list of leaves a
    // person can move to a value MORE protective than the default, and recovery
    // from a corrupt config carries those values across rather than landing on
    // the shipped default — because a wipe may lose a preference and must never
    // lose a protection.
    //
    // A leaf on that list and `agent-writable` here is that promise with a hole
    // in it: the ACCIDENT is refused and the DELIBERATE write by something that
    // is not the person is not. Nine leaves sat in exactly that state, and an
    // agent-originated `PATCH /api/config` flipped every one of them back with a
    // 200 and nothing on screen.
    //
    // Written as a set comparison rather than a loop so the failure NAMES the
    // offenders — the fix is "give this leaf a verdict on both sides", which
    // needs to be readable from the red.
    const carryovers = PROTECTIVE_CARRYOVERS.map((entry) => entry.path);
    expect(carryovers.length).toBeGreaterThan(20);
    const writableAnyway = carryovers.filter(
      (path) => CONFIG_WRITE_POLICY[path as keyof typeof CONFIG_WRITE_POLICY] !== 'operator-only'
    );
    expect(writableAnyway).toEqual([]);
  });

  it('names only leaves this table has a verdict for', () => {
    // The guard above compares two hand-maintained lists, so it passes silently
    // if a carryover path has drifted out of the schema and out of this table at
    // the same time: `undefined !== 'operator-only'` would catch that, but a
    // typo'd path would then read as an unfixable failure rather than as the
    // stale entry it is. This says which of the two it is.
    const unclassified = PROTECTIVE_CARRYOVERS.map((entry) => entry.path).filter(
      (path) => !(path in CONFIG_WRITE_POLICY)
    );
    expect(unclassified).toEqual([]);
  });

  it('actually reaches those leaves from a patch, rather than only classifying them', () => {
    // A verdict in the table is not enforcement. DOR-1113 is the precedent: six
    // fields were classified `operator-only` for months while the matcher could
    // not build the path that names them, so every check found them CLEAN and
    // "found nothing" is indistinguishable from "allowed". This drives the real
    // matcher with the real patch shape for each carryover leaf.
    for (const { path } of PROTECTIVE_CARRYOVERS) {
      expect(findOperatorOnlyPaths(patchForPath(path)), `unguarded: ${path}`).toContain(path);
    }
  });
});

describe('REQUIRES_LOGIN_CONFIG_PATHS drift guard', () => {
  it('covers every leaf of the approvals subtree', () => {
    // A third `approvals.*` setting added later must not get the weaker bar just
    // by existing. `operator-only` alone does not cover it: on `PATCH /api/config`
    // that check allows any caller while login is off, which would leave the new
    // setting pre-armable by an agent for the day the person turns login on.
    const approvalsLeaves = configSchemaLeafPaths().filter(
      (p) => p === 'approvals' || p.startsWith('approvals.')
    );
    expect(approvalsLeaves.length).toBeGreaterThan(0);
    expect(approvalsLeaves.filter((p) => !REQUIRES_LOGIN_CONFIG_PATHS.includes(p))).toEqual([]);
  });

  it('lists nothing that is not a leaf of UserConfigSchema', () => {
    const schemaLeaves = new Set(configSchemaLeafPaths());
    expect(REQUIRES_LOGIN_CONFIG_PATHS.filter((p) => !schemaLeaves.has(p))).toEqual([]);
  });

  it('requires the stricter bar only on top of the operator-only one', () => {
    // The login requirement is an ADDITION, never a substitution. A path that
    // needed login but was agent-writable would be reachable from the capability
    // surface with no bar at all.
    for (const dotPath of REQUIRES_LOGIN_CONFIG_PATHS) {
      expect(CONFIG_WRITE_POLICY[dotPath as keyof typeof CONFIG_WRITE_POLICY]).toBe(
        'operator-only'
      );
    }
  });
});

describe('findLoginRequiredPaths', () => {
  it('catches the exact leaf', () => {
    expect(findLoginRequiredPaths({ approvals: { standingGrants: true } })).toEqual([
      'approvals.standingGrants',
    ]);
  });

  it('catches a patch that stops SHORT of the guarded leaf', () => {
    // `{ approvals: true }` never reaches a leaf as a dot-path, so a plain
    // equality check would wave it through to the merge.
    expect(findLoginRequiredPaths({ approvals: true })).toEqual([
      'approvals.standingGrants',
      'approvals.standingGrantsVoidBefore',
      'approvals.trustWindowMinutes',
    ]);
    expect(findLoginRequiredPaths({ approvals: {} })).toEqual([
      'approvals.standingGrants',
      'approvals.standingGrantsVoidBefore',
      'approvals.trustWindowMinutes',
    ]);
  });

  it('catches the window as well as the switch', () => {
    // Lengthening the window widens the same hole the switch opens.
    expect(findLoginRequiredPaths({ approvals: { trustWindowMinutes: 1440 } })).toEqual([
      'approvals.trustWindowMinutes',
    ]);
  });

  it('leaves every other setting to the ordinary bar', () => {
    expect(findLoginRequiredPaths({ auth: { enabled: false }, ui: { theme: 'dark' } })).toEqual([]);
    expect(findLoginRequiredPaths(undefined)).toEqual([]);
    expect(findLoginRequiredPaths([{ approvals: { standingGrants: true } }])).toEqual([]);
  });
});

describe('findOperatorOnlyPaths', () => {
  it('catches the escalation it exists for', () => {
    expect(findOperatorOnlyPaths({ auth: { enabled: false } })).toEqual(['auth.enabled']);
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

/**
 * Build a patch that writes one policy dot-path, materializing every `[]`
 * segment as a one-element array — so `connectors.rawMcpServers[].url` becomes
 * `{ connectors: { rawMcpServers: [{ url: … }] } }`, which is the shape a caller
 * actually sends.
 *
 * @param dotPath - A policy path, `[]` segments included.
 * @param leaf - The value to write at the end of it.
 * @returns The patch object.
 */
function patchForPath(dotPath: string, leaf: unknown = 'x'): Record<string, unknown> {
  const segments = dotPath.split('.');
  let node: unknown = leaf;
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i]!;
    const isArray = segment.endsWith('[]');
    const key = isArray ? segment.slice(0, -2) : segment;
    node = { [key]: isArray ? [node] : node };
  }
  return node as Record<string, unknown>;
}

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
      'runtimes.claudeCode.accounts[].id',
      'runtimes.claudeCode.accounts[].label',
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

/**
 * The path matcher exactly as it stood before DOR-1113 taught it to descend into
 * arrays. Kept here, in the test, as the reference the new behavior is compared
 * against: the fix had to close the `[]` gap without moving a single verdict on
 * any other path, and "identical to the old code" is the only honest way to say
 * that.
 *
 * @param value - The patch node being walked.
 * @param prefix - Internal accumulator for the current path.
 * @returns Dot-paths for every leaf and every empty branch, treating an array as
 *   a leaf.
 */
function legacyPatchPaths(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return prefix ? [prefix] : [];
  return entries.flatMap(([key, child]) =>
    legacyPatchPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

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

  it('agrees with the pre-fix matcher on the login bar too', () => {
    // `findLoginRequiredPaths` shares the matcher and guards no `[]` path, so it
    // must come out of this change completely unmoved.
    for (const dotPath of plainPaths) {
      for (const patch of patchesFor(dotPath)) {
        const legacy = legacyFindOperatorOnlyPaths(patch).filter((path) =>
          REQUIRES_LOGIN_CONFIG_PATHS.includes(path)
        );
        expect(findLoginRequiredPaths(patch), `${dotPath}`).toEqual(legacy);
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

/**
 * The stake clause a refusal used for one path: the words between the previous
 * sentence and the `: <path>.` that lists it. Read back out of the finished
 * message on purpose, so these tests judge what an agent actually receives
 * rather than the table it was built from.
 *
 * @param message - A finished refusal.
 * @param path - The dot-path whose clause is wanted.
 * @returns The clause, or `''` when the message never names the path.
 */
function stakeClauseFor(message: string, path: string): string {
  const end = message.indexOf(`: ${path}`);
  if (end === -1) return '';
  const before = message.slice(0, end);
  const boundary = before.lastIndexOf('. ');
  return boundary === -1 ? before : before.slice(boundary + 2);
}

describe('OPERATOR_ONLY_STAKES drift guard', () => {
  it('gives every operator-only path a stake, and names none twice', () => {
    // The refusal text is only honest if the stake it cites is true of the path
    // it is citing, so every operator-only path has to be filed under exactly one
    // stake. A path with no stake still gets an honest fallback sentence at
    // runtime; this test is what stops that fallback becoming the normal case.
    const filed = OPERATOR_ONLY_STAKES.flatMap((group) => group.paths);
    expect([...filed].sort()).toEqual([...OPERATOR_ONLY_CONFIG_PATHS].sort());
    expect(new Set(filed).size).toBe(filed.length);
  });

  it('says something real about every path, not just a colon', () => {
    // The guard above only proves a path is FILED. A group whose `description`
    // was emptied or trimmed to a word still files every path it holds, and the
    // refusal would then read ": auth.enabled." — a sentence that names the
    // setting and says nothing about it. So the clause each path actually
    // produces is read back here, one path at a time.
    for (const path of OPERATOR_ONLY_CONFIG_PATHS) {
      const clause = stakeClauseFor(describeOperatorOnlyRefusal([path]), path);
      expect(clause, `no clause for ${path}`).not.toBe('');
      expect(clause, `fallback clause for ${path}`).not.toBe(
        'Settings the person keeps for themselves'
      );
      // Three words is not a style rule, it is the floor at which a clause can
      // still be a claim about the setting rather than a label.
      expect(clause.split(' ').length, `clause too thin for ${path}: "${clause}"`).toBeGreaterThan(
        3
      );
    }
  });
});

describe('describeOperatorOnlyRefusal', () => {
  it('names what was refused and what to do instead', () => {
    const message = describeOperatorOnlyRefusal(['auth.enabled']);
    expect(message).toContain('auth.enabled');
    expect(message).toContain('DorkOS changed nothing');
    expect(message).toMatch(/ask the person/i);
  });

  it('keeps the reach description for the settings it is true of', () => {
    const message = describeOperatorOnlyRefusal(['auth.enabled', 'tunnel.domain']);
    expect(message).toContain(
      'Who can reach this instance, and how far it reaches on this machine'
    );
    expect(message).toContain('auth.enabled, tunnel.domain');
  });

  it('describes a raw MCP server as a tool DorkOS attaches, not as a way in', () => {
    // A configured raw-MCP server is an endpoint DorkOS reaches OUT to and hands
    // sessions as a tool. Nothing about it lets anybody in, so the inbound
    // "who can reach this instance" sentence is the wrong claim: it sits with
    // the approved lists, which is what the module's own prose says about it.
    const message = describeOperatorOnlyRefusal([
      'connectors.rawMcpServers[].url',
      'extensions.approvedToRun',
    ]);
    expect(message).toContain(
      'Which code this server runs, and which outside tools it attaches to: ' +
        'connectors.rawMcpServers[].url, extensions.approvedToRun.'
    );
    expect(message).not.toMatch(/who can reach this instance/i);
  });

  it('describes a room bound as what it is, not as a security control', () => {
    // A reply ceiling is not the login gate. Telling a model it is teaches the
    // model something false about the product (DOR-1044).
    const message = describeOperatorOnlyRefusal([
      'rooms.engagedWindowMinutes',
      'rooms.maxAgentDepth',
    ]);
    expect(message).toContain('When your agents speak on their own');
    expect(message).toContain('rooms.engagedWindowMinutes, rooms.maxAgentDepth');
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/credentials/i);
    expect(message).not.toMatch(/leaves this machine/i);
  });

  it('describes a greeting cap as what it is', () => {
    const message = describeOperatorOnlyRefusal(['welcomeBack.maxPosts']);
    expect(message).toContain('When your agents speak on their own');
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/credentials/i);
    expect(message).not.toMatch(/leaves this machine/i);
  });

  it('gives a mixed refusal one sentence per stake, each naming its own paths', () => {
    const message = describeOperatorOnlyRefusal([
      'auth.enabled',
      'telemetry.usage',
      'welcomeBack.enabled',
    ]);
    expect(message).toContain(
      'Who can reach this instance, and how far it reaches on this machine: auth.enabled.'
    );
    expect(message).toContain('What leaves this machine: telemetry.usage.');
    expect(message).toContain('welcomeBack.enabled.');
  });

  it('reaches the stake copy for a list the caller replaced wholesale (DOR-1113)', () => {
    // Written the long way round — patch in, refusal out — because until DOR-1113
    // the matcher never returned a `[]` path, so the clause filed for these four
    // was DEAD: correct, tested against a hand-written path list, and impossible
    // for a real caller to ever read.
    const refusedServers = findOperatorOnlyPaths({
      connectors: { rawMcpServers: [{ slug: 'evil', url: 'https://evil.test/mcp' }] },
    });
    expect(describeOperatorOnlyRefusal(refusedServers)).toContain(
      'Which code this server runs, and which outside tools it attaches to: ' +
        'connectors.rawMcpServers[].slug, connectors.rawMcpServers[].url.'
    );

    const refusedAccounts = findOperatorOnlyPaths({
      runtimes: { claudeCode: { accounts: [{ path: '/tmp/evil' }] } },
    });
    expect(describeOperatorOnlyRefusal(refusedAccounts)).toContain(
      'Which account and keys the work runs on, and who pays for it: ' +
        'runtimes.claudeCode.accounts[].path.'
    );
  });

  it('describes a tool-group switch as what it is, and not as more', () => {
    // Three ways to get this clause wrong, all guarded here. It is not `code`
    // (nothing is loaded or attached) and not `reach` (nobody gets in) — and it
    // must not promise ACCESS either, because `resolveToolConfig` feeds the
    // context blocks and the tier gate is what decides what a tool may do.
    const message = describeOperatorOnlyRefusal([
      'agentContext.relayTools',
      'agentContext.tasksTools',
    ]);
    expect(message).toContain(
      'Which DorkOS tool groups your agents are told about: ' +
        'agentContext.relayTools, agentContext.tasksTools.'
    );
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/which code this server runs/i);
    // The overstatement this stake was split out to avoid.
    expect(message).not.toMatch(/tools your agents (are given|may use)/i);
  });

  it('describes a memory bound as a memory bound, not as a security control', () => {
    // Warm sessions are safety-neutral — same executable, same permissions, same
    // per-dispatch boundary check — and the refusal must not imply otherwise
    // just because the setting is now refused (DOR-1044, applied to DOR-1497).
    const message = describeOperatorOnlyRefusal([
      'runtimes.claudeCode.persistentSession',
      'uploads.maxFiles',
    ]);
    expect(message).toContain(
      'How much of this machine the work may take up: ' +
        'runtimes.claudeCode.persistentSession, uploads.maxFiles.'
    );
    expect(message).not.toMatch(/who can reach this instance/i);
    expect(message).not.toMatch(/credentials/i);
    expect(message).not.toMatch(/speak on their own/i);
  });

  it('stays honest about a path with no stake on file', () => {
    const message = describeOperatorOnlyRefusal(['some.future.setting']);
    expect(message).toContain('some.future.setting');
    expect(message).toContain('Settings the person keeps for themselves');
    expect(message).not.toMatch(/who can reach this instance/i);
  });
});
