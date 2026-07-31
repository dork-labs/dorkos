/**
 * The deep health run: gather what the live server knows, then judge it.
 *
 * `dorkos doctor` answers everything that can be read from a cold machine. The
 * checks here are the ones that cannot: they need the room store, the relay,
 * the adapter manager, and the mesh registry as they are right now. The route
 * `GET /api/health/deep` is the only caller in the server.
 *
 * Every dependency is optional and structurally typed. A subsystem that is
 * switched off or failed to start produces one `info` line saying its checks
 * were skipped — never a `fail`, because "you do not use chat integrations" is
 * not a broken machine.
 *
 * @module services/observability/deep-health/run
 */
import type { CheckResult } from '@dorkos/shared/health-schemas';
import {
  checkAdapterEntries,
  checkDuplicateAgentIds,
  checkRelayAccessRules,
  checkRelayBindingGhosts,
  checkRoomSessionTranscripts,
  type RelayBinding,
  type RoomSessionBinding,
} from './checks.js';
import {
  collectAgentManifests,
  collectTranscriptSessionIds,
  listAgentHomeDirectories,
} from './collect.js';

/** The runtime that owns Claude Code transcripts; only its sessions have a `.jsonl`. */
const CLAUDE_CODE_RUNTIME = 'claude-code';

/** The room store, narrowed to the one read the transcript check needs. */
export interface RoomSessionSource {
  listRoomSessions(): RoomSessionBinding[];
}

/** The relay, narrowed to its access-rule reads. */
export interface RelayAccessSource {
  isAccessControlQuarantined(): boolean;
  listAccessRules(): readonly unknown[];
}

/** The adapter manager, narrowed to the reads the integration checks need. */
export interface AdapterSource {
  listUnparsedEntryIds(): readonly string[];
  listAdapters(): ReadonlyArray<{ config: { id: string } }>;
  getBindingStore(): { getAll(): RelayBinding[] } | undefined;
}

/** The mesh, narrowed to "which agent ids exist and where do they live". */
export interface MeshAgentSource {
  listWithPaths(): ReadonlyArray<{ id: string; projectPath: string }>;
}

/** Everything the deep checks may read. Each part is optional and degrades on its own. */
export interface DeepHealthDeps {
  /** The resolved DorkOS data directory. */
  dorkHome: string;
  roomSessions?: RoomSessionSource | undefined;
  /** Absolute paths of the `projects` folders holding Claude Code transcripts. */
  transcriptProjectRoots?: (() => string[]) | undefined;
  /** Which runtime owns a session; used to skip runtimes that keep no transcript. */
  runtimeForSession?: ((sessionId: string) => Promise<string>) | undefined;
  relay?: RelayAccessSource | undefined;
  adapters?: AdapterSource | undefined;
  mesh?: MeshAgentSource | undefined;
}

/**
 * Run every deep check and return the checklist.
 *
 * Never throws: a check that cannot read what it needs degrades to `info`. The
 * order is stable so a person watching two runs side by side can compare them
 * line for line.
 *
 * @param deps - The live subsystems to read.
 * @returns One {@link CheckResult} per check, in a fixed order.
 */
export async function runDeepHealthChecks(deps: DeepHealthDeps): Promise<CheckResult[]> {
  return [
    await roomTranscriptCheck(deps),
    relayAccessCheck(deps),
    adapterEntriesCheck(deps),
    bindingGhostCheck(deps),
    duplicateAgentIdCheck(deps),
  ];
}

/** Room bindings whose transcript is gone (Claude Code sessions only). */
async function roomTranscriptCheck(deps: DeepHealthDeps): Promise<CheckResult> {
  if (!deps.roomSessions || !deps.transcriptProjectRoots) {
    return skipped('Rooms remember their conversations', 'the room store is not available');
  }
  const all = deps.roomSessions.listRoomSessions();
  // Only Claude Code writes a transcript file. A Codex or OpenCode session has
  // no `.jsonl` by design, so counting it as missing would be a false alarm.
  const bindings = deps.runtimeForSession
    ? await filterClaudeCodeSessions(all, deps.runtimeForSession)
    : all;
  const transcriptSessionIds = collectTranscriptSessionIds(deps.transcriptProjectRoots());
  return checkRoomSessionTranscripts({ bindings, transcriptSessionIds });
}

/** Keep only bindings whose session belongs to the runtime that writes transcripts. */
async function filterClaudeCodeSessions(
  bindings: readonly RoomSessionBinding[],
  runtimeForSession: (sessionId: string) => Promise<string>
): Promise<RoomSessionBinding[]> {
  const kept: RoomSessionBinding[] = [];
  for (const binding of bindings) {
    try {
      if ((await runtimeForSession(binding.sessionId)) === CLAUDE_CODE_RUNTIME) kept.push(binding);
    } catch {
      // Unknown owner: leave it out rather than report a transcript that was
      // never supposed to exist.
    }
  }
  return kept;
}

/** Whether the relay's access rules loaded. */
function relayAccessCheck(deps: DeepHealthDeps): CheckResult {
  if (!deps.relay) {
    return skipped('Agent messaging rules loaded', 'agent messaging is not running');
  }
  const quarantined = deps.relay.isAccessControlQuarantined();
  // A quarantined evaluator holds no rules, so asking for them would report a
  // reassuring zero next to a failure.
  return checkRelayAccessRules({
    quarantined,
    ruleCount: quarantined ? 0 : deps.relay.listAccessRules().length,
  });
}

/** Saved chat integrations whose settings could not be read. */
function adapterEntriesCheck(deps: DeepHealthDeps): CheckResult {
  if (!deps.adapters) {
    return skipped('Chat integrations are readable', 'no chat integrations are set up');
  }
  return checkAdapterEntries({ unparsedCount: deps.adapters.listUnparsedEntryIds().length });
}

/** Relay bindings pointing at an integration or agent that is gone. */
function bindingGhostCheck(deps: DeepHealthDeps): CheckResult {
  const bindings = deps.adapters?.getBindingStore()?.getAll();
  if (!deps.adapters || !deps.mesh || !bindings) {
    return skipped('Chat connections point at real agents', 'no chat integrations are set up');
  }
  return checkRelayBindingGhosts({
    bindings,
    knownAdapterIds: new Set(deps.adapters.listAdapters().map((a) => a.config.id)),
    registeredAgentIds: new Set(deps.mesh.listWithPaths().map((a) => a.id)),
  });
}

/**
 * Agent ids claimed by more than one folder.
 *
 * The folders read are every registered agent's project folder plus everything
 * directly under the agents home — bounded and cheap. A full sweep of the
 * configured scan roots would find copies nobody has registered yet, and is
 * deliberately not done here: it walks arbitrarily large trees on a request.
 */
function duplicateAgentIdCheck(deps: DeepHealthDeps): CheckResult {
  if (!deps.mesh) {
    return skipped('Agent ids are unique', 'the agent registry is not available');
  }
  const directories = [
    ...deps.mesh.listWithPaths().map((agent) => agent.projectPath),
    ...listAgentHomeDirectories(deps.dorkHome),
  ];
  return checkDuplicateAgentIds({ manifests: collectAgentManifests(directories) });
}

/** The verdict for a check whose subsystem is not there to ask. */
function skipped(label: string, because: string): CheckResult {
  return { label, status: 'info', detail: `Skipped — ${because}.` };
}
