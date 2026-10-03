/**
 * Whether a schedule's model is one DorkOS credits serve, when its runs go on
 * credits (DOR-2636).
 *
 * A schedule's runs launch through the same account ladder as any session:
 * the schedule's own account, else its agent's, else the machine default. When
 * that lands on credits and the service says which protocols its models are
 * on, a save naming a model credits do not serve on the runtime's protocol is
 * refused, as the session and agent model gates refuse it. A service that says
 * nothing about protocols judges nothing, exactly as before. A run whose model
 * is no longer served is not refused: the launch runs it on the service's
 * suggestion and says so (`resolveCreditsLaunchModel`).
 *
 * @module services/tasks/lifecycle/schedule-credits-model
 */
import { CREDITS_ACCOUNT_ID } from '@dorkos/shared/account-usage';
import { creditsModelRefusal } from '../../core/cloud/credits-model-gate.js';
import { runtimeRegistry } from '../../core/runtime-registry.js';
import { checkClaudeLaunchAccount } from '../../runtimes/claude-code/launch-account-check.js';

/**
 * The sentence to refuse a schedule's model with, or `null` when it may be
 * saved (no model, not on credits, credits serve it, or the service says
 * nothing about protocols).
 *
 * @param opts - What the schedule names.
 * @param opts.model - The model it names, if any.
 * @param opts.account - The account it names, if any.
 * @param opts.runtime - The runtime it names; absent means the default runtime.
 * @param opts.folder - The folder its runs start in (`scheduleRunFolder`).
 */
export async function scheduleCreditsModelRefusal(opts: {
  model: string | null | undefined;
  account: string | null | undefined;
  runtime: string | null | undefined;
  folder: string;
}): Promise<string | null> {
  if (!opts.model) return null;
  const type = opts.runtime || runtimeRegistry.getDefaultType();
  if (!runtimeRegistry.has(type)) return null;
  const runtime = runtimeRegistry.get(type);
  if (runtime.getCapabilities().credits === undefined) return null;
  // Accounts are Claude Code's ladder; another runtime runs on credits only
  // when the schedule names them.
  const onCredits =
    type === 'claude-code'
      ? await checkClaudeLaunchAccount({ cwd: opts.folder, hintId: opts.account || undefined })
          .then((launch) => launch.ok && launch.accountId === CREDITS_ACCOUNT_ID)
          .catch(() => false)
      : opts.account === CREDITS_ACCOUNT_ID;
  return onCredits ? creditsModelRefusal(runtime, opts.model) : null;
}
