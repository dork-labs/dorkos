/**
 * The deep health run: gather what the live server knows, then judge it.
 *
 * `dorkos doctor` answers everything that can be read from a cold machine. The
 * checks here are the ones that cannot: they need the room store, the relay,
 * the adapter manager, and the mesh registry as they are right now. The route
 * `GET /api/health/deep` is the only caller in the server.
 *
 * Every dependency is optional and structurally typed, and every check is
 * contained: one that is missing, off, or actively throwing costs exactly one
 * line of the report. That containment is the whole point — this endpoint is
 * read during an incident, which is precisely when a subsystem is most likely
 * to be mid-crash, and a report that 500s then is worse than no report.
 *
 * @module services/observability/deep-health/run
 */
import type { CheckResult } from '@dorkos/shared/health-schemas';
import {
  surveyRoomBindingTranscripts,
  type RoomBindingTranscriptDeps,
} from '../../rooms/session-bindings/room-binding-transcripts.js';
import type { RoomSessionBinding } from '../../rooms/session-bindings/room-session-ledger.js';
import {
  checkAdapterEntries,
  checkDuplicateAgentIds,
  checkRelayAccessRules,
  checkRelayBindingGhosts,
  checkRoomSessionTranscripts,
  type RelayBinding,
} from './checks.js';
import { collectAgentManifests, listAgentHomeDirectories } from './collect.js';

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
  /**
   * The shared "does this binding still have its conversation" probe
   * (`services/rooms/session-bindings/room-binding-transcripts.ts`), which the boot-time
   * convergence sweep asks too — absent on an install with no claude-code
   * runtime, where nothing could answer it.
   */
  roomBindingTranscripts?: RoomBindingTranscriptDeps | undefined;
  relay?: RelayAccessSource | undefined;
  adapters?: AdapterSource | undefined;
  mesh?: MeshAgentSource | undefined;
  /**
   * Whether a missing subsystem is missing because it *failed*, rather than
   * because it was never turned on. An absent object cannot tell those apart,
   * and they need opposite reactions: one is a note, the other is a problem.
   */
  relayFailedToStart?: boolean | undefined;
  adaptersFailedToStart?: boolean | undefined;
  meshFailedToStart?: boolean | undefined;
}

/**
 * Run every deep check and return the checklist.
 *
 * Never throws and never rejects. The order is stable so a person watching two
 * runs side by side can compare them line for line.
 *
 * @param deps - The live subsystems to read.
 * @returns One {@link CheckResult} per check, in a fixed order.
 */
export async function runDeepHealthChecks(deps: DeepHealthDeps): Promise<CheckResult[]> {
  return [
    await contain('Rooms remember their conversations', () => roomTranscriptCheck(deps)),
    await contain('Agent messaging rules loaded', () => relayAccessCheck(deps)),
    await contain('Chat integrations are readable', () => adapterEntriesCheck(deps)),
    await contain('Chat connections point at real agents', () => bindingGhostCheck(deps)),
    await contain('Agent ids are unique', () => duplicateAgentIdCheck(deps)),
  ];
}

/**
 * Run one check, turning any throw into that check's own line.
 *
 * A subsystem caught mid-crash throws rather than answering — `RelayCore`
 * refuses every read once it is closed, for instance. Letting that escape would
 * lose the other four checks and hand the operator a blank 500 at the exact
 * moment they are trying to find out what broke.
 *
 * The degraded line names the check and nothing else: the thrown error may
 * carry a path, a session id, or a token, and this response is content-free.
 *
 * @param label - The check's label, so the line reads like the others.
 * @param run - The check.
 * @returns The check's own result, or a `warn` standing in for it.
 */
async function contain(
  label: string,
  run: () => CheckResult | Promise<CheckResult>
): Promise<CheckResult> {
  try {
    return await run();
  } catch {
    return {
      label: `Could not run the check: ${label.toLowerCase()}`,
      status: 'warn',
      detail:
        'The part of DorkOS this check reads did not answer. It may be starting up, ' +
        'shutting down, or mid-crash.',
      fix: 'Check the DorkOS log, then restart it if this persists.',
    };
  }
}

/**
 * Room bindings whose transcript is gone.
 *
 * The probe is the shared one, so this answer and the boot-time convergence
 * sweep's cannot disagree about a binding (DOR-805). It decides for itself which
 * bindings are its business — a session on a runtime that keeps no transcript is
 * not — and reports what it could not read apart from what it judged.
 */
async function roomTranscriptCheck(deps: DeepHealthDeps): Promise<CheckResult> {
  if (!deps.roomSessions || !deps.roomBindingTranscripts) {
    return skipped('Rooms remember their conversations', 'the room store is not available');
  }
  const survey = await surveyRoomBindingTranscripts(
    deps.roomSessions.listRoomSessions(),
    deps.roomBindingTranscripts
  );
  return checkRoomSessionTranscripts({
    judgedCount: survey.judged,
    orphaned: survey.missing,
    unreadableCount: survey.unreadable,
  });
}

/** Whether the relay's access rules loaded. */
function relayAccessCheck(deps: DeepHealthDeps): CheckResult {
  if (!deps.relay) {
    return deps.relayFailedToStart
      ? failedToStart('Agent messaging rules loaded', 'Agent messaging')
      : skipped('Agent messaging rules loaded', 'agent messaging is not turned on');
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
    return deps.adaptersFailedToStart
      ? failedToStart('Chat integrations are readable', 'Chat integrations')
      : skipped('Chat integrations are readable', 'no chat integrations are set up');
  }
  return checkAdapterEntries({ unparsedCount: deps.adapters.listUnparsedEntryIds().length });
}

/** Relay bindings pointing at an integration or agent that is gone. */
function bindingGhostCheck(deps: DeepHealthDeps): CheckResult {
  const label = 'Chat connections point at real agents';
  if (!deps.adapters) {
    return deps.adaptersFailedToStart
      ? failedToStart(label, 'Chat integrations')
      : skipped(label, 'no chat integrations are set up');
  }
  if (!deps.mesh) {
    return deps.meshFailedToStart
      ? failedToStart(label, 'The agent registry')
      : skipped(label, 'the agent registry is not available');
  }
  const bindings = deps.adapters.getBindingStore()?.getAll();
  if (!bindings) {
    return skipped(label, 'no chat connections have been made');
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
    return deps.meshFailedToStart
      ? failedToStart('Agent ids are unique', 'The agent registry')
      : skipped('Agent ids are unique', 'the agent registry is not available');
  }
  const directories = [
    ...deps.mesh.listWithPaths().map((agent) => agent.projectPath),
    ...listAgentHomeDirectories(deps.dorkHome),
  ];
  return checkDuplicateAgentIds({ manifests: collectAgentManifests(directories) });
}

/** The verdict for a check whose subsystem was never turned on. */
function skipped(label: string, because: string): CheckResult {
  return { label, status: 'info', detail: `Skipped — ${because}.` };
}

/** The verdict for a check whose subsystem was meant to be running and is not. */
function failedToStart(label: string, subject: string): CheckResult {
  return {
    label,
    status: 'warn',
    detail: `Skipped — ${subject} was turned on but failed to start, so there was nothing to ask.`,
    fix: 'Check the DorkOS log for the startup error, then restart it.',
  };
}
