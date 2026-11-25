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
  findOperatorOnlyPaths,
} from '../config-write-policy.js';
import { OPERATOR_ONLY_STAKES } from '../operator-only-stakes.js';
import { describeOperatorOnlyRefusal } from '../operator-only-refusal.js';
import { patchForPath } from './config-write-policy/config-write-policy.fixtures.js';

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
      // How long Activity keeps the history a person reviews (spec `audit-trail`).
      'activity.retentionDays',
      'agents.defaultDirectory',
      'auth.enabled',
      'browser.enabled',
      'cloud.credits.agents',
      'cloud.credits.defaults',
      'cloud.credits.linkedTo',
      'cloud.credits.offer',
      'cloud.instanceName',
      'cloud.instanceToken',
      'cloud.linkedAccountLabel',
      'cloud.previousLinkProof',
      'cloud.remote.consentVersion',
      'cloud.remote.credentialId',
      'cloud.remote.credentialRef',
      'cloud.remote.edgeProofHeader',
      'cloud.remote.edgeProofRef',
      'cloud.remote.enrolmentId',
      'cloud.remote.fingerprint',
      'cloud.remote.hosts',
      'cloud.remote.instanceId',
      'cloud.remote.mode',
      'computers.enabled',
      'connectors.rawMcpServers[].displayName',
      'connectors.rawMcpServers[].slug',
      'connectors.rawMcpServers[].transport',
      'connectors.rawMcpServers[].url',
      // Whether the Docs experiment is on (DOR-2993).
      'docs.enabled',
      'extensions.approvedPermissions',
      'extensions.approvedSources',
      'extensions.approvedToRun',
      'extensions.disabled',
      'extensions.dismissedApprovals',
      'extensions.enabled',
      'extensions.forwardAgents',
      'extensions.legacySlotless',
      'extensions.legacyUnsourced',
      'extensions.roomAccess',
      'extensions.trustedSources[].source',
      'extensions.trustedSources[].trustedAt',
      // A person's yes or no to an agent's own folder settings (DOR-3068).
      'harness.approvedFolderConfig',
      'harness.approvedFolderConfigParts',
      'harness.approvedHooks',
      // A person's yes or no to repo and worktree settings (DOR-3298).
      'harness.approvedRepoConfig',
      'harness.autoAdopt',
      'harness.autoSync',
      'harness.folderConfigPinned',
      'harness.global.askedAt',
      'harness.global.harnesses',
      'harness.refusedFolderConfig',
      'harness.refusedHooks',
      'harness.refusedRepoConfig',
      'harness.repoBaselines',
      'harness.repoBaselinesPinned',
      // Whether agents wake on their own at all (spec `heartbeats` §3.6).
      'heartbeats.enabled',
      // Which room hears "nothing is running": an agent could aim the alert elsewhere (DOR-3675).
      'heartbeats.idleAlertRoomId',
      // Whether cheap checks spend DorkOS credits: the owner's money (spec `heartbeats` §6.3).
      'heartbeats.triageOnCredits',
      // Whether this computer sleeps while agents work, and whether it may be
      // woken for a schedule: the person's battery and the person's machine
      // (spec `keep-awake`).
      'keepAwake.wakeForScheduledTasks',
      'keepAwake.whileAgentsWork',
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
      // Company certificates the desktop app trusts: whom every connection
      // believes (DOR-3361). The env variable it replaced is ignored for this.
      'network.extraCaCertsPath',
      // Every way the operator finds out something is waiting on them. An agent
      // able to write these could silence its own alarm and then park on a
      // question nobody is told about (spec `notification-system`, DOR-1385).
      'notifications.browserPermissionPrimerDismissed',
      'notifications.escalation.phoneAfterMinutes',
      'notifications.notifyOnTurnCompleteWhileAway',
      'notifications.sounds.allClear',
      'notifications.sounds.knock',
      'notifications.sounds.turnEnd',
      // The first run (one-minute-onboarding §4.1): its DorkOS path is what a
      // new link reads to record credits as the person's own pick, so it decides
      // who pays; finished and dismissed close that door, so an agent may not
      // reopen it; the undo target and the welcome's entry are the route's own.
      'onboarding.completedAt',
      'onboarding.dismissedAt',
      'onboarding.firstRunPath',
      'onboarding.priorRuntime',
      'onboarding.welcomeEntryId',
      // What agents may do. The generic writers refuse these outright; this is
      // the second line (spec `agent-permissions` D10).
      // A person's yes or no to an agent's own folder allow list (DOR-3039).
      'permissions.approvedFolderAllowRules',
      'permissions.approvedFolderAllows',
      'permissions.defaults.actions',
      'permissions.defaults.areas',
      'permissions.preset',
      'permissions.refusedFolderAllows',
      'permissions.sharedAppsAppliedAt',
      'permissions.sharedAtUpgrade',
      'permissions.trustedStoresAppliedAt',
      'permissions.upgradeSweptVersion',
      // The record of WHO wrote the display name, not the name itself — which
      // stays agent-writable, because DorkBot saving "call me Dorian" is the
      // onboarding flow (DOR-1022). An agent able to write these could stamp its
      // own suggestion `operator` and erase the only sign the name was proposed.
      'profile.displayNameSource.agentName',
      'profile.displayNameSource.kind',
      'providers',
      'relay.dataDir',
      'relay.maxAgentTurnsPerAgentPerHour',
      'relay.maxAgentTurnsTotalPerHour',
      // The master switch for every way in from another device (DOR-3650).
      'remoteAccess.enabled',
      'rooms.collectDebounceMs',
      'rooms.collectMaxEntries',
      'rooms.engagedWindowMinutes',
      'rooms.engagedWindowPosts',
      'rooms.maxAgentDepth',
      'rooms.maxAutomaticTurnsPerRoomPerHour',
      'rooms.maxAutomaticTurnsTotalPerHour',
      'rooms.maxConcurrentTurnsPerAgent',
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
      // Whether agents may pick an account by name (DOR-5033).
      'runtimes.claudeCode.accounts[].agentsMayPick',
      'runtimes.claudeCode.accounts[].color',
      'runtimes.claudeCode.accounts[].id',
      'runtimes.claudeCode.accounts[].label',
      // An account a person kept out of automatic moves (Re-seat P0).
      'runtimes.claudeCode.accounts[].noAutoMove',
      // Where each account may work, and which accounts each project may use:
      // they bound where a credential is used (spec flow-multiproject §8).
      'runtimes.claudeCode.accounts[].onlyProjects',
      'runtimes.claudeCode.accounts[].path',
      'runtimes.claudeCode.defaultAccount',
      'runtimes.claudeCode.defaultAccountColor',
      'runtimes.claudeCode.defaultAccountOnlyProjects',
      'runtimes.claudeCode.defaultTrustStop',
      // Which found account folders Settings stops offering: it curates the
      // roster, and its only writer is the dismiss route (claude-account-ui §7.4).
      'runtimes.claudeCode.dismissedFolders',
      // How many agents may run at once: memory on this machine (DOR-3012).
      'runtimes.claudeCode.maxWarmProcesses',
      // Not for the reason its neighbours are here: warm sessions are
      // safety-neutral and cost memory. It is the wipe floor — a person who
      // turned it off wanted the gigabyte back, and the Control Center's 'Warm
      // agents' switch is where they say so (DOR-1497).
      'runtimes.claudeCode.persistentSession',
      'runtimes.claudeCode.projectAccounts',
      'runtimes.codex.binaryPath',
      'runtimes.codex.credentialRef',
      'runtimes.codex.defaultTrustStop',
      'runtimes.codex.transport',
      'runtimes.defaultTrustStop',
      'runtimes.doe.defaultTrustStop',
      'runtimes.doe.inference.credentialEndpoint',
      'runtimes.doe.inference.credentialRef',
      'runtimes.doe.inference.endpoint',
      'runtimes.doe.inference.protocol',
      'runtimes.doe.inference.provider',
      'runtimes.doe.inference.source',
      'runtimes.environment.inherit.claudeCode',
      'runtimes.environment.inherit.codex',
      'runtimes.environment.inherit.doe',
      'runtimes.environment.inherit.opencode',
      // The load gate agents' heavy shell jobs wait behind: an agent that could
      // loosen any of it would be letting its own job past the wait (DOR-4209).
      'runtimes.loadGate.enabled',
      'runtimes.loadGate.hardCapMinutes',
      'runtimes.loadGate.heavyCommands.add',
      'runtimes.loadGate.heavyCommands.remove',
      'runtimes.loadGate.maxLoad',
      'runtimes.loadGate.maxWaitMinutes',
      'runtimes.loadGate.slots',
      // How many spin-off chats may run at once: an agent would be raising its
      // own limit (DOR-3413).
      'runtimes.maxAgentChats',
      'runtimes.opencode.baseURL',
      'runtimes.opencode.binaryPath',
      'runtimes.opencode.defaultTrustStop',
      'runtimes.opencode.provider',
      'scheduler.maxConcurrentRuns',
      'server.boundary',
      // Opens DorkOS to every device on the same network (DOR-2930).
      'server.lanAccess',
      // Whether this computer may be reached from the web through its hub (DOR-2946).
      'sessionRelay.enabled',
      'spaces.enabled',
      'spaces.official.url',
      // Whether agents may set a scheduled task's mode or approve one (DOR-3703).
      'tasks.agentModeControl',
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
      // Whose saved navigation this is, and where the person's next "switch
      // back to this DorkOS" lands. An agent could otherwise steer that click.
      'ui.communityNavigation.owners[].installationDestination.path',
      'ui.communityNavigation.owners[].installationDestination.search',
      'ui.communityNavigation.owners[].ownerKey',
      // How a chat with one agent is drawn, and whether its session shows
      // (DOR-3074): an experiment, and the readings about an agent's own work.
      'ui.dmView',
      'ui.showSessions',
      'ui.trustNoticeSeenAt',
      // Three uploads.* leaves a person can tighten past the shipped default,
      // all carried by the wipe floor (DOR-1505 added `allowedTypes`).
      'uploads.allowedTypes',
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
      'cloud.previousLinkProof',
      'cloud.remote.credentialRef',
      'cloud.remote.edgeProofRef',
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
