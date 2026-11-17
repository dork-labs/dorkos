/**
 * The words and the hold for the account-rule routes in
 * `runtimes-account-eligibility.ts`: who may change which projects a Claude
 * account works in, and whether agents move to it on their own.
 *
 * A rule that widens where an account may work waits for the owner to confirm
 * it's them (DOR-4355): letting a project use more accounts, an account work in
 * more projects, or agents move to an account on their own again. Narrowing one
 * stays immediate.
 *
 * @module routes/account-eligibility-hold
 */
import type { Context } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import type { RequestFacts } from '../http/request-facts.js';
import { logger } from '../lib/logger.js';
import type { PersonBarCopy } from './extensions-person-bar.js';
import { runFrontDoorWrite } from './front-door-step-up.js';

/** What the person bar says when anything but a person tries to change a rule. */
export const ACCOUNT_RULES_BAR: PersonBarCopy = {
  error: 'Only a person can change where an account may be used.',
  code: 'operator_only_config',
  subject: 'where each Claude account may be used',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Which projects an account may work in is something a person sets in their own copy ` +
    `of the app, not something another site can change for them.`,
  agent:
    'DorkOS changed nothing. Which projects a Claude account may work in is a decision ' +
    'only a person makes. Ask them to change it in Settings → Runtimes.',
};

/** What the person bar says when anything but a person flips an account's automatic-move switch. */
export const NO_AUTO_MOVE_BAR: PersonBarCopy = {
  error: 'Only a person can choose whether agents move here automatically.',
  code: 'operator_only_config',
  subject: 'whether agents move to each Claude account automatically',
  crossSite: (origin) =>
    `DorkOS changed nothing. This request came from ${origin}, which is not DorkOS. ` +
    `Whether agents move to an account automatically is something a person sets in their ` +
    `own copy of the app, not something another site can change for them.`,
  agent:
    'DorkOS changed nothing. Whether agents move to a Claude account automatically is a ' +
    'decision only a person makes. Ask them to change it in Settings → Runtimes.',
};

/** What a failed project account list save says. */
export const PROJECT_ACCOUNTS_FAILED = 'Could not save which accounts this project may use.';

/** What a failed account project list save says. */
export const ONLY_PROJECTS_FAILED = 'Could not save which projects this account may use.';

/** What a failed automatic-move switch save says. */
export const NO_AUTO_MOVE_FAILED = 'Could not save whether agents move to this account.';

/** One widening of an account rule, held. */
export interface AccountWidening {
  /** What it acts on, in the server's words. */
  target: string;
  /** Exactly what will be written, as plain JSON. */
  input: unknown;
  /** The sheet's sentence. */
  reason: string;
  /** What a failed write says. */
  failure: string;
  /** Write, as the confirming caller. */
  run: (who: RequestFacts) => Promise<Response>;
}

/**
 * Hold a rule that widens where an account may work for the owner's password.
 * The front-door bar runs again on confirmation.
 *
 * @param c - The request asking for the change.
 * @param hold - The fixed change and its write.
 */
export function holdAccountWidening(c: Context<ApiEnv>, hold: AccountWidening): Promise<Response> {
  const { failure, run, ...held } = hold;
  return runFrontDoorWrite(c, {
    kind: 'accounts.eligibility',
    subject: ACCOUNT_RULES_BAR.subject,
    ...held,
    run: async (who) => {
      try {
        return await run(who);
      } catch (err) {
        logger.error('[Runtimes] could not save an account rule', { err: String(err) });
        return c.json({ error: failure }, 500);
      }
    },
  });
}
