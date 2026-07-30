/**
 * Shared `CommunityAdapter` conformance suite — the behavioral gate every
 * community backend (local rooms, a Buzz relay, `apps/community`,
 * {@link ./fake-community-adapter.js | FakeCommunityAdapter}) clears. The
 * community analogue of `runtimeConformance` and `connectorConformance`.
 *
 * `communityConformance(makeAdapter, opts)` registers a `describe` block that
 * asserts the `CommunityAdapter` contract
 * (`packages/shared/src/community-adapter.ts`) against any backend,
 * parameterized by a factory.
 *
 * **Division of labour**, copied verbatim from `connector-conformance.ts`: this
 * suite covers community BEHAVIOR; the TypeScript interface covers SHAPE (an
 * adapter omitting a method fails compilation).
 *
 * **Capability-aware, never weakened.** Every legitimate backend difference is
 * a declared flag with a *branched* assertion — the `supportsMultiAccount`
 * doctrine, applied to thirteen flags instead of one. The hard requirement this
 * suite exists to hold: a backend with no roster, no invites and no read
 * cursors must pass without any assertion being softened for everyone else. If
 * satisfying one backend means weakening a shared assertion, the design is
 * wrong and the difference should be a declared capability instead.
 *
 * **What this suite deliberately does NOT assert**, complete, so nobody adds one
 * of them by mistake and nobody assumes a gate that is not there:
 *
 * - **File modes.** The credential contract is a `0700` directory and a `0600`
 *   file, which is filesystem-specific and belongs in a real adapter's own
 *   tests. What is asserted here is the property a fake can hold: no credential
 *   appears in anything the port returns.
 * - **Who may publish a presence signal.** The rule that a presence signal
 *   exists only while a real claim is held is enforced at the one producer and
 *   tested there — a port-level fake cannot know whether a claim was real.
 * - **That an entry's author is in the room's CURRENT roster.** An entry
 *   outlives its author's membership (our own rooms model keeps a departed
 *   member's entries in the log), so a roster-membership requirement would fail
 *   a correct backend. Attribution is proven where it can be: under
 *   `seedAgentEntry`, an agent's entry must carry the agent's id and never its
 *   owner's.
 * - **Anything about a backend that declines an optional hook.** Every hook-gated
 *   case registers a named `it.skip` when its hook is absent, so a declined case
 *   is visible in the run rather than a quiet pass. Read the skips.
 * - **A case this backend's declaration makes unrunnable.** Where a flag is off
 *   but still owes something observable, the off branch asserts it — a `canPost:
 *   false` backend must still refuse `post`, and that is a real assertion, not a
 *   skip. Where a flag being off leaves nothing to observe at all (agent
 *   admission on a backend that admits no agents; the machine-managed connect on
 *   a backend that holds no credential), the case registers a named `it.skip`.
 *   Either way it is visible in the run; neither is a silent green tick.
 *
 * @module test-utils/community-conformance
 */
import { describe } from 'vitest';
import type { CommunityAdapter } from '@dorkos/shared/community-adapter';
import { registerCapabilityBranchedAssertions } from './community-conformance-branched.js';
import {
  createCommunityConformanceContext,
  type CommunityConformanceOpts,
} from './community-conformance-support.js';
import { registerUniversalAssertions } from './community-conformance-universal.js';

export type { CommunityConformanceOpts } from './community-conformance-support.js';

/**
 * Register the shared CommunityAdapter conformance suite for one backend.
 *
 * Call at the top level of a Vitest test file. The factory is invoked once per
 * test so every assertion starts from a fresh adapter instance.
 *
 * **`makeAdapter` must return an adapter that can reach `'connected'`** with no
 * setup call in between — arrange whatever a live backend needs (an admitted
 * key, a running relay) inside the factory or outside the run. Half the suite
 * assumes a working connection, and C16 asserts it outright for a
 * machine-managed backend.
 *
 * @param makeAdapter - Factory producing a fresh, ready-to-use adapter.
 * @param opts - Required hooks + declared differences; see {@link CommunityConformanceOpts}.
 */
export function communityConformance(
  makeAdapter: () => CommunityAdapter,
  opts: CommunityConformanceOpts
): void {
  const ctx = createCommunityConformanceContext(makeAdapter, opts);
  describe(ctx.opts.name, () => {
    registerUniversalAssertions(ctx);
    registerCapabilityBranchedAssertions(ctx);
  });
}
