/**
 * Whether a start may run in a project at all: the account rule (spec
 * `flow-multiproject` §7.7, §8.4 "Starting work from an extension").
 *
 * A start goes through the same account ladder as any launch, with the
 * project: `resolveLaunchAccountRoot({ project })`, the Claude Code ladder
 * (DOR-2526). A start names no account and no agent, so only the default rungs
 * run: the default account, else the first eligible one, else a refusal. The
 * refusal becomes `StartWorkError('account_not_allowed_here')` with the ladder's
 * plain §8.3 sentence, before anything is written. A runtime without accounts
 * has nothing to refuse.
 *
 * The launch service asks the same question again for the new session, so a
 * rule that changes between the two answers is still honoured there.
 *
 * @module services/extensions/start-work-eligibility
 */
import type { ProjectRef } from '@dorkos/extension-api/server';
import { resolveLaunchAccountRoot } from '../runtimes/claude-code/claude-config-dir.js';

/** What a start's account check answers. */
export type StartWorkEligibilityResult = { ok: true } | { ok: false; message: string };

/** The account check a start runs before it launches anything. */
export type StartWorkEligibility = (input: {
  /** The project the chat would run in. */
  project: ProjectRef;
  /** The runtime it would run on. */
  runtime: string;
}) => StartWorkEligibilityResult;

/** The runtime whose account ladder {@link checkStartWorkEligibility} asks. */
const RUNTIME_WITH_ACCOUNTS = 'claude-code';

/**
 * The account check: whether some account may work in the project, on the
 * runtime the chat would start on. See the module documentation.
 */
export const checkStartWorkEligibility: StartWorkEligibility = ({ project, runtime }) => {
  if (runtime !== RUNTIME_WITH_ACCOUNTS) return { ok: true };
  const launch = resolveLaunchAccountRoot({ project });
  return launch.ok ? { ok: true } : { ok: false, message: launch.error.message };
};
