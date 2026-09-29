/**
 * Whether a start may run in a project at all: the account rule (spec
 * `flow-multiproject` §7.7, §8.4 "Starting work from an extension").
 *
 * A start goes through the same account ladder as any launch, with the
 * project, and a refusal becomes `StartWorkError('account_not_allowed_here')`
 * with the ladder's plain message. Phase 2 ships this seam before phase 3's
 * rules exist, so until they land every account is eligible and the refusal
 * cannot happen; the code path and its type exist now so an extension handles
 * it from the start.
 *
 * **Phase 3 (DOR-2526) fills {@link checkStartWorkEligibility}**: it asks
 * `resolveLaunchAccountRoot({ project })` for a runtime that has accounts and
 * answers `{ ok: false, message }` with the refusal's message. Nothing else in
 * the start-work seam changes.
 *
 * @module services/extensions/start-work-eligibility
 */
import type { ProjectRef } from '@dorkos/extension-api/server';

/** What a start's account check answers. */
export type StartWorkEligibilityResult = { ok: true } | { ok: false; message: string };

/** The account check a start runs before it launches anything. */
export type StartWorkEligibility = (input: {
  /** The project the chat would run in. */
  project: ProjectRef;
  /** The runtime it would run on. */
  runtime: string;
}) => StartWorkEligibilityResult;

/**
 * The account check today: every account is eligible, because no account or
 * project rule exists yet (phase 3). See the module documentation.
 */
export const checkStartWorkEligibility: StartWorkEligibility = () => ({ ok: true });
