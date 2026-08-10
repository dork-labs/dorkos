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
      'mcp.apiKey',
      'mcp.enabled',
      'mcp.rateLimit.enabled',
      'mcp.rateLimit.maxPerWindow',
      'mcp.rateLimit.windowSecs',
      'mesh.scanRoots',
      'providers',
      'relay.dataDir',
      'rooms.engagedWindowMinutes',
      'rooms.engagedWindowPosts',
      'rooms.maxAgentDepth',
      'rooms.maxAutomaticTurnsPerRoomPerHour',
      'rooms.maxAutomaticTurnsTotalPerHour',
      'runtimes.claudeCode.accounts[].label',
      'runtimes.claudeCode.accounts[].path',
      'runtimes.claudeCode.activeAccount',
      'runtimes.claudeCode.defaultTrustStop',
      'runtimes.codex.binaryPath',
      'runtimes.codex.credentialRef',
      'runtimes.codex.defaultTrustStop',
      'runtimes.defaultTrustStop',
      'runtimes.opencode.baseURL',
      'runtimes.opencode.binaryPath',
      'runtimes.opencode.defaultTrustStop',
      'runtimes.opencode.provider',
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
      'welcomeBack.absenceThresholdMinutes',
      'welcomeBack.enabled',
      'welcomeBack.maxPosts',
      'workspace.rootPath',
    ]);
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

  it('stays honest about a path with no stake on file', () => {
    const message = describeOperatorOnlyRefusal(['some.future.setting']);
    expect(message).toContain('some.future.setting');
    expect(message).toContain('Settings the person keeps for themselves');
    expect(message).not.toMatch(/who can reach this instance/i);
  });
});
