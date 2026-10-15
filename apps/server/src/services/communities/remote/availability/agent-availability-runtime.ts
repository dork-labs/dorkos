/**
 * Keeps one availability reporter running for each space connection with an enrolled agent
 * (specs/server-merge step 3, DOR-2878).
 *
 * @module services/communities/remote/availability/agent-availability-runtime
 */
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import type { CommunityWireAgentRunsOn } from '@dorkos/shared/community-wire';
import type { CommunityAgentEnrollmentStore } from '../agent-enrollment-store.js';
import type { RemoteConnectionChangeListener } from '../connection-changes.js';
import {
  AgentAvailabilityReporter,
  type AvailabilitySpace,
} from './agent-availability-reporter.js';

/** How often the set of reporting connections is re-read from local state, in milliseconds. */
export const AVAILABILITY_RECONCILE_MS = 30_000;

/** What the runtime reads and starts. */
export interface AgentAvailabilityRuntimeDeps {
  /** This installation's enrollments: which connections have agents, and which agents. */
  enrollments: Pick<CommunityAgentEnrollmentStore, 'activeConnections' | 'activeForOwner'>;
  /** The connection's adapter, which reads the space's features and sends the report. */
  spaces: (communityRef: CommunityRef, ownerAuthorId: string) => AvailabilitySpace;
  /**
   * What kind of computer runs one agent, by its local id. This is where an agent computer says
   * so: an app running as one answers `agent-computer`.
   */
  runsOn: (localAgentId: string) => CommunityWireAgentRunsOn;
  /** Whether a space may be reached now. Every space is reachable when not given. */
  reachable?: (communityRef: CommunityRef) => boolean;
  /** Committed connection changes, so a disconnect stops its reporter at once. */
  onConnectionChange?: (listener: RemoteConnectionChangeListener) => () => void;
  /** Told once per connection when its reports start failing. */
  onFailing?: (communityRef: CommunityRef, error: unknown) => void;
  /** Spreads every wait; see {@link AgentAvailabilityReporter}. */
  random?: () => number;
  /** The clock, in milliseconds. */
  now?: () => number;
  /** How often to re-read which connections report; {@link AVAILABILITY_RECONCILE_MS}. */
  reconcileMs?: number;
}

/**
 * The app's side of agent availability. While it runs, every space connection with at least one
 * agent this installation enrolled has one {@link AgentAvailabilityReporter}, which names only
 * that connection's agents, so a report never crosses spaces. A connection that loses its last
 * agent, or is disconnected, has its reporter disposed; an agent removed from a connection drops
 * out of that connection's next report, which reads enrollments fresh. {@link stop} clears every
 * timer.
 */
export class AgentAvailabilityRuntime {
  private readonly reporters = new Map<string, AgentAvailabilityReporter>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private running = false;

  constructor(private readonly deps: AgentAvailabilityRuntimeDeps) {}

  /** Start a reporter for each connection with an enrolled agent, and keep the set current. */
  start(): void {
    if (this.running) return;
    this.running = true;
    // A connection that is no longer connected stops reporting at once; a newly connected one
    // starts on this refresh rather than the next reconcile.
    this.unsubscribe = this.deps.onConnectionChange?.((changes) => {
      for (const change of changes)
        if (change.status !== 'connected') this.drop(key(change.ref, change.ownerKey));
      if (changes.some((change) => change.status === 'connected')) this.refresh();
    });
    this.timer = setInterval(
      () => this.refresh(),
      this.deps.reconcileMs ?? AVAILABILITY_RECONCILE_MS
    );
    this.timer.unref?.();
    this.refresh();
  }

  /** Stop every reporter and timer. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const id of [...this.reporters.keys()]) this.drop(id);
  }

  /** Re-read which connections report, now: after an enrollment or a disconnect. */
  refresh(): void {
    if (!this.running) return;
    const wanted = new Map<string, { communityRef: CommunityRef; ownerAuthorId: string }>();
    for (const connection of this.deps.enrollments.activeConnections()) {
      if (this.deps.reachable && !this.deps.reachable(connection.communityRef)) continue;
      wanted.set(key(connection.communityRef, connection.ownerAuthorId), connection);
    }
    for (const id of [...this.reporters.keys()]) if (!wanted.has(id)) this.drop(id);
    for (const [id, connection] of wanted) {
      if (this.reporters.has(id)) continue;
      const reporter = this.reporterFor(connection.communityRef, connection.ownerAuthorId);
      this.reporters.set(id, reporter);
      reporter.start();
    }
  }

  /** The connections reporting now, each as its ref and owner joined by a NUL; for tests. */
  reporting(): readonly string[] {
    return [...this.reporters.keys()];
  }

  private reporterFor(communityRef: CommunityRef, ownerAuthorId: string) {
    const { enrollments, reachable, onFailing } = this.deps;
    return new AgentAvailabilityReporter({
      space: this.deps.spaces(communityRef, ownerAuthorId),
      agents: () =>
        enrollments.activeForOwner(communityRef, ownerAuthorId).map((enrollment) => ({
          agentId: enrollment.remoteMemberId,
          localAgentId: enrollment.localAgentId,
        })),
      runsOn: this.deps.runsOn,
      reachable: () => reachable?.(communityRef) ?? true,
      onFailing: onFailing && ((error) => onFailing(communityRef, error)),
      random: this.deps.random,
      now: this.deps.now,
    });
  }

  private drop(id: string): void {
    this.reporters.get(id)?.dispose();
    this.reporters.delete(id);
  }
}

function key(communityRef: CommunityRef, ownerAuthorId: string): string {
  return `${communityRef}\0${ownerAuthorId}`;
}
