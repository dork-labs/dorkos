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
import { grantScope } from './enrollment.js';

/**
 * A report within this many seconds of the last recorded one, saying the same kind of computer,
 * writes nothing. A report is a heartbeat, so an app that sends more often than asked costs the
 * space a read, not a row version per agent each time. Well under the report interval, so a
 * recorded time is never more than this much older than the newest report.
 */
export const AVAILABILITY_COALESCE_SECONDS = 30;

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
      // One statement: find the agents this grant may report for, and record the report on any
      // whose last one is old enough or named another kind of computer.
      const result = await pool.query<{ id: string }>(
        `WITH reported AS (
           SELECT * FROM unnest($3::uuid[], $4::text[]) AS r(id, runs_on)
         ), owned AS (
           SELECT a.id, r.runs_on FROM agents a JOIN reported r ON r.id = a.id
           WHERE a.community_id = $1 AND a.owner_member_id = $2 AND a.active
             AND ${grantScope('a', '$5::uuid')}
         ), recorded AS (
           UPDATE agents a SET runs_on = o.runs_on, last_seen_at = now()
           FROM owned o
           WHERE a.id = o.id AND a.community_id = $1
             AND (a.last_seen_at IS NULL OR a.runs_on IS DISTINCT FROM o.runs_on
               OR a.last_seen_at < now() - make_interval(secs => $6))
           RETURNING a.id
         )
         SELECT id FROM owned`,
        [
          member.community_id,
          member.id,
          named.map((agent) => agent.agentId),
          named.map((agent) => agent.runsOn),
          member.grant_id,
          AVAILABILITY_COALESCE_SECONDS,
        ]
      );
      for (const row of result.rows) accepted.add(row.id);
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
