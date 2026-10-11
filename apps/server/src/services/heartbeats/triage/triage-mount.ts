/**
 * Triage on a decision model at server startup (spec `heartbeats` §6.2, §6.3):
 * starts the credits triage, mounts `PUT /api/heartbeats/triage-credits`,
 * builds the Heartbeat page's checks block, and raises the credits offer's one
 * notification when it first stands.
 *
 * @module services/heartbeats/triage/triage-mount
 */
import { randomUUID } from 'node:crypto';
import type { Express } from 'express';
import type { Db } from '@dorkos/db';
import type { HeartbeatChecks } from '@dorkos/shared/heartbeat-schemas';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { createHeartbeatTriageRouter } from '../../../routes/heartbeat-triage.js';
import { recordAudit } from '../../audit/audit-trail.js';
import { configManager } from '../../core/config-manager.js';
import { creditsCanBeHad } from '../../core/cloud/credits-availability.js';
import { startHeartbeatTriage, stopHeartbeatTriage } from '../../decisions/triage-wiring.js';
import { notify } from '../../notifications/notification-service.js';
import type { RaiseStore } from '../raises/raise-store.js';
import { createBeatTriagePort, type BeatTriagePort } from './beat-triage.js';
import {
  checksStatus,
  checksToday,
  notifyOfferOnce,
  offerOpen,
  requestsTodayUtc,
} from './triage-checks.js';

/** What startup hands over. */
export interface TriageMountDeps {
  /** The Express app, for the choice route. */
  app: Express;
  /** The server's database, for today's checks. */
  db: Db;
  /** The report queue, for what can wait. */
  raises: RaiseStore;
  /** The chain person's zone, which decides what "today" is. */
  timezone(): string;
}

/** What startup keeps. */
export interface TriageMount {
  /** The beat runner's triage port. */
  port: BeatTriagePort;
  /**
   * The Heartbeat page's checks block for one agent.
   *
   * @param agent - The agent's id and runtime.
   * @param viewerIsOwner - Whether the viewer may answer the offer.
   */
  checks(agent: { id: string; runtime: string }, viewerIsOwner: boolean): Promise<HeartbeatChecks>;
  /** Stop following config and forget the credits triage. */
  stop(): void;
}

/** `heartbeats.triageOnCredits` now; a stored section without it is "not chosen". */
function choice(): boolean | null {
  return configManager.get('heartbeats').triageOnCredits ?? null;
}

/** Whether the offer stands now. */
function offerStands(): boolean {
  return offerOpen(choice(), creditsCanBeHad(), configManager.get('heartbeats').enabled);
}

/**
 * Store a person's answer to the offer and record it.
 *
 * @param useCredits - **Use credits** (`true`) or **Not now** (`false`).
 */
function setChoice(useCredits: boolean): void {
  configManager.set('heartbeats', {
    ...configManager.get('heartbeats'),
    triageOnCredits: useCredits,
  });
}

/**
 * The record row for a person's answer.
 *
 * @param before - The choice before.
 * @param after - The choice now.
 */
function recordChoice(before: boolean | null, after: boolean): void {
  recordAudit({
    action: 'heartbeat.config_changed',
    operation: 'modify',
    target: { type: 'setting', id: 'heartbeats.triageOnCredits' },
    outcome: 'ok',
    change: [{ field: 'heartbeats.triageOnCredits', before, after }],
    summary: after
      ? 'Chose DorkOS credits for cheap checks.'
      : 'Kept cheap checks off DorkOS credits.',
    visibility: 'space',
  });
}

/**
 * Start triage on a decision model.
 *
 * @param deps - What startup hands over.
 */
export function mountTriage(deps: TriageMountDeps): TriageMount {
  const credits = startHeartbeatTriage({ requestsToday: requestsTodayUtc(deps.db, new Date()) });
  deps.app.use(
    '/api/heartbeats/triage-credits',
    createHeartbeatTriageRouter({ choice, setChoice, record: recordChoice })
  );
  const offer = () =>
    void notifyOfferOnce({
      dorkHome: resolveDorkHome(),
      open: offerStands,
      notify: () => notify('heartbeat.credits-offer', {}),
      nowIso: () => new Date().toISOString(),
    });
  offer();
  const unwatch = configManager.onChange((change) => {
    if (change.sections.includes('cloud') || change.sections.includes('heartbeats')) offer();
  });
  return {
    port: createBeatTriagePort(deps.raises, randomUUID),
    async checks(agent, viewerIsOwner) {
      const source = await credits.source();
      return checksStatus({
        runsOn: source.runsOn,
        runtime: agent.runtime,
        today: checksToday(deps.db, agent.id, new Date(), deps.timezone()),
        offerOpen: offerStands(),
        viewerIsOwner,
      });
    },
    stop() {
      unwatch();
      stopHeartbeatTriage();
    },
  };
}
