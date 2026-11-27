/**
 * The person's view of the load gate's waiting line (DOR-4209): the heavy shell
 * jobs waiting for the computer to be less busy, and three actions on one of
 * them. Let through runs it now, past the load limit. Urgent moves it ahead of
 * every normal job. Move to front puts it first, ahead of urgent ones too.
 *
 * **A person's routes only, reads included.** The list names which agents and
 * chats are waiting, which no agent learns about another (`load-gate.ts`), so
 * every route here, the read too, takes the three person bars
 * (`extensions-person-bar.ts`) and a caller at this computer. No route here is
 * meant for agents, and there is no MCP tool for any of it.
 *
 * **The residual, as named on those bars.** With no owner set up there is no
 * session to prove a person, so a program on this computer that leaves out the
 * agent headers passes, an agent's own shell included. Signing up an owner
 * closes it, and the real boundary is DOR-3053.
 *
 * **Who did it is recorded here.** Any program running as this user can write a
 * mark in the shared folder by hand, so the gate's own log line never says a
 * person did it. These routes write the audit row, and its summary is built
 * only from the constants below and the agent name this server holds in
 * memory. Nothing in the shared folder (a ticket, a mark) ever becomes audit
 * text.
 *
 * @module routes/system-load-gate
 */
import type { Context, Hono } from 'hono';
import type { LoadGateJobAction, LoadGateWaitingLine } from '@dorkos/shared/load-gate-queue';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts } from '../http/request-facts.js';
import { classifyRequest } from '../lib/request-classifier.js';
import { problem } from '@dorkos/http-kit';
import { currentServerRole } from '../lib/server-role.js';
import { recordAudit, type RecordAuditInput } from '../services/audit/audit-trail.js';
import type { JobActionResult } from '../services/core/load-gate/job-actions.js';
import type { LoadGate } from '../services/core/load-gate/load-gate.js';
import { machineLoadGate } from '../services/core/load-gate/machine-load-gate.js';
import { waitingLineForPerson } from '../services/core/load-gate/person-view.js';
import { isTicketId } from '../services/core/load-gate/ticket-queue.js';
import { refusedNotAPerson } from './extensions-person-bar.js';
import type { PersonBarCopy } from '../lib/http/person-bar.js';

const COPY: PersonBarCopy = {
  code: 'person_only',
  subject: 'the waiting jobs',
  agent: 'An agent can’t see or change the waiting jobs. Ask a person in the DorkOS app.',
};

/** The part of the gate these routes use. */
export type LoadGateForPerson = Pick<
  LoadGate,
  'waitingJobs' | 'letThrough' | 'markUrgent' | 'moveToFront'
>;

/** What the routes read, each replaceable in tests. */
export interface LoadGateRouteDeps {
  /** The server's load gate. */
  gate?: () => LoadGateForPerson;
  /** Where a person's action is recorded. */
  audit?: (input: RecordAuditInput) => unknown;
}

/** One action: what it does to the gate, and how the audit trail names it. */
interface ActionSpec {
  run: (gate: LoadGateForPerson, id: string) => JobActionResult;
  auditAction: string;
  /** The summary, given the agent's name when this server holds one. */
  summary: (agentName: string | undefined) => string;
}

const whose = (agentName: string | undefined): string =>
  agentName === undefined ? 'a' : `${agentName}’s`;

const ACTIONS: Record<LoadGateJobAction, ActionSpec> = {
  'let-through': {
    run: (gate, id) => gate.letThrough(id),
    auditAction: 'load-gate.let-through',
    summary: (agent) => `Let ${whose(agent)} waiting heavy job run now`,
  },
  urgent: {
    run: (gate, id) => gate.markUrgent(id),
    auditAction: 'load-gate.urgent',
    summary: (agent) => `Marked ${whose(agent)} waiting heavy job urgent`,
  },
  front: {
    run: (gate, id) => gate.moveToFront(id),
    auditAction: 'load-gate.move-to-front',
    summary: (agent) => `Moved ${whose(agent)} waiting heavy job to the front of the line`,
  },
};

/** A refusal for anyone but a person at this computer, or `undefined` to go on. */
function refusedNotHere(c: Context<ApiEnv>): Response | undefined {
  const refused = refusedNotAPerson(c, COPY);
  if (refused) return refused;
  if (classifyRequest(honoRequestFacts(c), currentServerRole()).kind !== 'this-computer') {
    return problem(c, 'operator_only', { detail: 'Do this at the computer running DorkOS.' });
  }
  return undefined;
}

/**
 * Mount the routes.
 *
 * @param router - The `/api/system` router.
 * @param deps - The gate and the audit trail; the server's own by default.
 */
export function mountLoadGateRoutes(router: Hono<ApiEnv>, deps: LoadGateRouteDeps = {}): void {
  const gate = deps.gate ?? machineLoadGate;
  const audit = deps.audit ?? recordAudit;
  const line = (): LoadGateWaitingLine => waitingLineForPerson(gate().waitingJobs());

  router.get('/load-gate/waiting', (c) => {
    const refused = refusedNotHere(c);
    if (refused) return refused;
    return c.json(line() satisfies LoadGateWaitingLine);
  });

  for (const [action, spec] of Object.entries(ACTIONS) as [LoadGateJobAction, ActionSpec][]) {
    router.post(`/load-gate/jobs/:id/${action}`, (c) => {
      const refused = refusedNotHere(c);
      if (refused) return refused;
      const id = c.req.param('id');
      const invalidId = () =>
        problem(c, 'invalid_request', { detail: 'That isn’t a waiting job’s id.' });
      // Checked first, so an id that cannot be a job's never costs a read of the folder.
      if (!isTicketId(id)) return invalidId();
      // Read before the action, from this server's memory only: the job leaves the line once it starts.
      const agentName = line().jobs.find((job) => job.id === id)?.agentName;
      const result = spec.run(gate(), id);
      if (result === 'invalid-id') return invalidId();
      if (result === 'not-found') {
        return problem(c, 'not_found', { detail: 'That job isn’t waiting anymore.' });
      }
      if (result === 'unavailable') {
        return problem(c, 'temporarily_unavailable', {
          detail: 'Couldn’t reach the waiting jobs. Try again.',
        });
      }
      audit({
        action: spec.auditAction,
        operation: 'modify',
        outcome: 'ok',
        target: { type: 'load-gate-job', id },
        summary: spec.summary(agentName),
        source: { surface: 'app' },
      });
      return c.json(line() satisfies LoadGateWaitingLine);
    });
  }
}
