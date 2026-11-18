/** Per-action confirmation for writes that leave lasting access or move account data. */
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { honoRequestFacts, type RequestFacts } from '../http/request-facts.js';
import { refuseFrontDoorChange } from '../lib/caller-authority.js';
import { readOwnerAccount } from '../services/core/auth/index.js';
import type {
  StepUpActionInput,
  StepUpCommitResult,
} from '../services/core/auth/step-up/step-up-holds.js';
import { holdForStepUp } from './step-up-guard.js';
import { presentsAgentIdentity } from '../middleware/agent-identity.js';
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
}

/** The JSON response a held write returns through the confirmation route. */
async function resultOf(response: Response): Promise<StepUpCommitResult> {
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: 'The request could not be completed.' };
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
  const { subject, run, agentCard, ...held } = action;
  const facts = honoRequestFacts(c);
  const refusal = refuseFrontDoorChange(facts, subject);
  if (refusal && agentCard && (facts.agentIdentity || presentsAgentIdentity(facts))) {
    const card = raiseAgentCard(
      { identity: facts.agentIdentity, presentsAgent: true },
      { kind: held.kind, target: held.target, input: held.input, ...agentCard() }
    );
    return c.json(card.body, card.status);
  }
  if (refusal) return c.json({ error: refusal.error, code: refusal.code }, 403);
  if (readOwnerAccount() === null) return run(facts);
  return holdForStepUp(c, {
    ...held,
    commit: async (confirming) => {
      try {
        const stale = refuseFrontDoorChange(confirming, subject);
        if (stale) {
          held.onDiscard?.();
          return { status: 403, body: { error: stale.error, code: stale.code } };
        }
        const result = await resultOf(await run(confirming));
        if (result.status >= 400) held.onDiscard?.();
        return result;
      } catch (error) {
        held.onDiscard?.();
        throw error;
      }
    },
  });
}
