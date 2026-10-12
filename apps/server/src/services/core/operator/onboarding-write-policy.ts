/**
 * The `onboarding` section's verdicts in `CONFIG_WRITE_POLICY`, kept in
 * a module of their own so the policy table stays under the line limit. Same
 * rules as every other verdict there: read that module's doc first.
 *
 * @module services/core/operator/onboarding-write-policy
 */
import type { ConfigWriteAccess } from './config-write-policy.js';

/** Who may write each `onboarding` leaf. Spread into `CONFIG_WRITE_POLICY`. */
export const ONBOARDING_WRITE_POLICY = {
  'onboarding.completedSteps': 'agent-writable',
  'onboarding.skippedSteps': 'agent-writable',
  'onboarding.startedAt': 'agent-writable',
  // Finished and dismissed close the first run, and with it the door that lets
  // a new link record DorkOS credits as the person's pick
  // (`recordFirstRunCreditsChoice`). An agent able to clear either could reopen
  // that door, so only a person writes them; the app writes them as the person.
  'onboarding.dismissedAt': 'operator-only',
  'onboarding.completedAt': 'operator-only',
  // A timestamp saying the first-run flow already picked a default runtime. It
  // grants nothing and guards nothing; an agent rewriting it can at most let
  // first-run setup ask the question again on a machine that is past it.
  'onboarding.runtimeDefaultSetAt': 'agent-writable',
  // `'dorkos'` here is what lets a new link record DorkOS credits as the
  // person's own pick for the DorkOS runtime, so it decides who pays. It is a
  // person's pick on the Welcome screen, and an agent may not make it for them.
  'onboarding.firstRunPath': 'operator-only',
  // The runtime a later first-run pick moves `runtimes.default` and DorkBot back
  // to. Written only by the first-run route, behind a person.
  'onboarding.priorRuntime': 'operator-only',
  // Which #team entry the app treats as DorkBot's welcome and hangs the
  // first-tool chips under. An agent could point it at a message it wrote.
  'onboarding.welcomeEntryId': 'operator-only',
} as const satisfies Record<string, ConfigWriteAccess>;

/**
 * The operator-only `onboarding` leaves filed under the `credentials` stake in
 * `OPERATOR_ONLY_STAKES`: the first run's DorkOS path, which a new link reads to
 * record credits as the person's pick while the first run is open (neither
 * finished nor dismissed), and the runtime the route undoes to (spec
 * `one-minute-onboarding` §4.1).
 */
export const ONBOARDING_CREDENTIAL_PATHS = [
  'onboarding.firstRunPath',
  'onboarding.completedAt',
  'onboarding.dismissedAt',
  'onboarding.priorRuntime',
] as const;
