/** Per-action confirmation for writes that leave lasting access or move account data. */
import type { Context } from 'hono';
import { problem, problemBody, sendProblem, type ProblemStatus } from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { refuseFrontDoorChange, type OperatorCookieRefusal } from '../lib/caller-authority.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type {
  StepUpActionInput,
  StepUpCommitResult,
} from '../services/core/auth/step-up/step-up-holds.js';
import { holdForStepUp } from './step-up-guard.js';
import { presentsAgentIdentity } from '../lib/http/agent-identity-header.js';
import {
  raiseAgentCard,
  type AgentRaiseWrite,
} from '../services/core/approvals/agent-raise/agent-raise-cards.js';

/** A validated write, with its own response and the subject of its front-door bar. */
export interface FrontDoorWrite extends Omit<StepUpActionInput, 'commit'> {
  subject: string;
  /** Recheck mutable prerequisites, then write using the confirming caller. */
  run: (confirming: RequestFacts) => Promise<Response>;
  /**
   * How an agent's request for this write goes on a card instead of being refused
   * (DOR-4355 M4). Only a route that can describe the effect from stored state, and
   * re-check that state inside its write, supplies one; every other route keeps the 403.
   */
  agentCard?: () => Pick<AgentRaiseWrite, 'effect' | 'run'>;
  /**
   * Told what a confirmation answered, once the person's password passed:
   * the status of the write, or of the bar that refused it on the confirming request.
   */
  onConfirmed?: (status: number) => void;
  /**
   * Bind the confirmation to the asking request's ingress kind (this computer,
   * the owner's own tunnel, managed remote access, Wi-Fi, as the gate marked
   * it): a confirm that came another way is refused, even from the same
   * session (DOR-4978, Security t1j).
   */
  bindIngress?: true;
}

/** What a confirm that came another way than its ask is told. */
export const CONFIRM_ANOTHER_WAY = 'Confirm this the same way you asked for it.';

/**
 * The front-door bar's refusal (`refuseFrontDoorChange`) as a problem document:
 * `operator_only`, its sentence as the detail.
 *
 * @param c - The request's context.
 * @param refusal - What the bar decided.
 * @returns The 403.
 */
export function frontDoorProblem(c: Context, refusal: OperatorCookieRefusal): Response {
  return problem(c, 'operator_only', { detail: refusal.error });
}

/** The JSON response a held write returns through the confirmation route. */
async function resultOf(response: Response): Promise<StepUpCommitResult> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = problemBody('internal_error', {
        detail: 'The request could not be completed.',
        ...(response.status >= 400 ? { status: response.status as ProblemStatus } : {}),
      });
    }
  }
  return { status: response.status, body };
}

/**
 * Hold a validated front-door write for the existing confirmation sheet.
 * With no owner yet there is no password to ask for, so its existing bar suffices.
 * The bar runs again against the confirming request before anything is written.
 *
 * @param c - The request asking for the write.
 * @param action - The validated, fixed action and its commit.
 */
export async function runFrontDoorWrite(
  c: Context<ApiEnv>,
  action: FrontDoorWrite
): Promise<Response> {
  const { subject, run, agentCard, onConfirmed, bindIngress, ...held } = action;
  const facts = honoRequestFacts(c);
  const refusal = refuseFrontDoorChange(facts, subject);
  if (refusal && agentCard && (facts.agentIdentity || presentsAgentIdentity(facts))) {
    const card = raiseAgentCard(
      { identity: facts.agentIdentity, presentsAgent: true },
      { kind: held.kind, target: held.target, input: held.input, ...agentCard() }
    );
    return card.refused ? sendProblem(c, card.body) : c.json(card.body, card.status);
  }
  if (refusal) return frontDoorProblem(c, refusal);
  if (readOwnerAccount() === null) return run(facts);
  const askedVia = facts.ingress;
  return holdForStepUp(c, {
    ...held,
    commit: async (confirming) => {
      try {
        if (bindIngress && confirming.ingress !== askedVia) {
          held.onDiscard?.();
          onConfirmed?.(403);
          return {
            status: 403,
            body: problemBody('operator_only', { detail: CONFIRM_ANOTHER_WAY }),
          };
        }
        const stale = refuseFrontDoorChange(confirming, subject);
        if (stale) {
          held.onDiscard?.();
          onConfirmed?.(403);
          return { status: 403, body: problemBody('operator_only', { detail: stale.error }) };
        }
        const result = await resultOf(await run(confirming));
        if (result.status >= 400) held.onDiscard?.();
        onConfirmed?.(result.status);
        return result;
      } catch (error) {
        held.onDiscard?.();
        onConfirmed?.(500);
        throw error;
      }
    },
  });
}
