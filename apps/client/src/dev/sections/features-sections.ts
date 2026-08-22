import type { PlaygroundSection } from '../playground-registry';
import { FEATURE_AGENT_SECTIONS } from './features-agent-sections';
import { FEATURE_SURFACE_SECTIONS } from './features-surface-sections';

/**
 * Feature component sections from FeaturesPage.
 *
 * Identity lives on its own page now (`identity-sections.ts`, spec
 * `identity-consistency` §W4) — the agent avatar, the team roster, the profile
 * surfaces and the account menu all moved there, so what is left here is the
 * subsystems the page is named for.
 *
 * **Two data files, one exported name.** The registry is a flat array with a
 * natural seam in the middle — an agent and its network, then the surfaces a
 * person answers things on — and it passed the 500-line cap. Splitting it there
 * keeps each half readable while leaving `FEATURES_SECTIONS` the single thing
 * the page, the config and the drift test all import. Order is preserved, and
 * it matters: the nav lists sections in this order.
 *
 * @module dev/sections/features-sections
 */
export const FEATURES_SECTIONS: PlaygroundSection[] = [
  ...FEATURE_AGENT_SECTIONS,
  ...FEATURE_SURFACE_SECTIONS,
];
