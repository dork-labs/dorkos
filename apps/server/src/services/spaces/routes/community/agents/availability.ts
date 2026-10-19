import type { Hono } from 'hono';
import type { Pool } from 'pg';
import { z } from 'zod';
import {
  COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
  CommunityWireAgentAvailabilityReportResponseSchema,
  CommunityWireAgentAvailabilityReportSchema,
} from '@dorkos/shared/community-wire';
import { requireConnectionGrant } from '../../../data.js';
import { json, readJson } from '../../../http.js';
import { grantScope } from './agent-scope.js';

/**
 * How old an agent's recorded report must be before a new one is written: half the report
 * interval. At the asked-for interval each report writes each agent's row once; a report sooner
 * than this after the last recorded one, for the same kind of computer, writes nothing, so an app
 * that reports too often costs the space reads, not row versions. The recorded time then trails
 * the newest report by under a minute, far inside the 360-second availability threshold.
 */
export const AVAILABILITY_RECORD_AFTER_SECONDS = COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS / 2;

const agentUuid = z.uuid();

/**
 * Register `POST /agents/availability` (specs/server-merge step 3a, DOR-2877): a paired app
 * reporting that the computer running its agents is on.
 *
 * It is made with the installation's own connection grant, the credential the app already sends
 * on every call, rather than each agent's key: one call covers all of the installation's agents,
 * and the grant is what the space records as each agent's enrolling installation. So a report
 * counts only for agents that grant may act on (its own, a legacy one, or an orphaned one of the
 * same person; see `grantScope`), and the rest are refused without saying why. It changes no
 * ownership, so it never adopts an agent, and it is allowed while the host holds the space,
 * because whether an agent is there is not growth.
 */
export function registerAgentAvailabilityRoutes(app: Hono, { pool }: { pool: Pool }) {
  app.post('/agents/availability', async (c) => {
    const { member } = await requireConnectionGrant(c, pool, 'enroll-agent', { allowHeld: true });
    const { agents } = await readJson(c, CommunityWireAgentAvailabilityReportSchema);
    // An id that is not a uuid names no agent here; asking the database would only fail the cast.
    const named = agents.filter((agent) => agentUuid.safeParse(agent.agentId).success);
    const accepted = new Set<string>();
    if (named.length) {
      // First read, without locking, which agents this grant may report for and which of them are
      // due a write (see AVAILABILITY_RECORD_AFTER_SECONDS). A report with nothing due ends here
      // having written nothing.
      const owned = await pool.query<{ id: string; runs_on: string; due: boolean }>(
        `SELECT a.id, r.runs_on,
           (a.last_seen_at IS NULL OR a.runs_on IS DISTINCT FROM r.runs_on
             OR a.last_seen_at < now() - make_interval(secs => $6)) AS due
         FROM agents a JOIN unnest($3::uuid[], $4::text[]) AS r(id, runs_on) ON r.id = a.id
         WHERE a.community_id = $1 AND a.owner_member_id = $2 AND a.active
           AND ${grantScope('a', '$5::uuid')}`,
        [
          member.community_id,
          member.id,
          named.map((agent) => agent.agentId),
          named.map((agent) => agent.runsOn),
          member.grant_id,
          AVAILABILITY_RECORD_AFTER_SECONDS,
        ]
      );
      for (const row of owned.rows) accepted.add(row.id);
      const due = owned.rows.filter((row) => row.due).sort((a, b) => (a.id < b.id ? -1 : 1));
      // Then write the due ones, locked in id order, so two reports naming the same agents in
      // another order wait for each other rather than deadlock. An agent removed in between is
      // skipped; it is still answered as accepted, as it was when the report arrived.
      if (due.length)
        await pool.query(
          `UPDATE agents a SET runs_on = r.runs_on, last_seen_at = now()
           FROM unnest($2::uuid[], $3::text[]) AS r(id, runs_on)
           WHERE a.id = r.id AND a.community_id = $1 AND a.id IN (
             SELECT l.id FROM agents l WHERE l.community_id = $1 AND l.id = ANY($2::uuid[])
               AND l.active ORDER BY l.id FOR UPDATE)`,
          [member.community_id, due.map((row) => row.id), due.map((row) => row.runs_on)]
        );
    }
    // Postgres answers ids in lower case; the app gets back the ids it sent.
    const wasAccepted = (agent: { agentId: string }) => accepted.has(agent.agentId.toLowerCase());
    return json(c, CommunityWireAgentAvailabilityReportResponseSchema, {
      accepted: agents.filter(wasAccepted).map((agent) => agent.agentId),
      refused: agents.filter((agent) => !wasAccepted(agent)).map((agent) => agent.agentId),
      reportEverySeconds: COMMUNITY_AGENT_AVAILABILITY_REPORT_SECONDS,
    });
  });
}
