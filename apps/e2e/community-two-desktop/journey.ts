import { agentSteps } from './steps-agents.js';
import { lifecycleSteps } from './steps-lifecycle.js';
import { setupSteps } from './steps-setup.js';
import { switchingSteps } from './steps-switching.js';
import type { JourneyContext } from './world.js';

/**
 * The member journey across two packaged DorkOS apps and two self-hosted
 * Communities (DOR-2182 "Packaged Desktop acceptance gate", DOR-2186
 * switching, accessibility and isolation).
 *
 * Two people, A and B, each run their own packaged app with its own home,
 * data and local server. A owns the "Desktop Proof" Community and invites B.
 * A also owns a second, separate "Isolation Proof" Community that B never
 * joins. Steps 1-19 (with 15b) are the original journey; steps 20-29 add the
 * agent, restart, lifecycle and invitation proofs.
 *
 * @module community-two-desktop/journey
 */

/**
 * Run the whole journey. Throws on the first failed step.
 *
 * @param ctx - Browser, apps, infrastructure and the step recorder.
 */
export async function runJourney(ctx: JourneyContext): Promise<void> {
  const world = await setupSteps(ctx);
  await switchingSteps(world);
  await agentSteps(world);
  await lifecycleSteps(world);
}
