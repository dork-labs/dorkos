/**
 * OpenCode's declared `opencode-power-source` settings section.
 *
 * OpenCode's sign-in is really a choice of where its models come from, so its
 * card carries that choice rather than an account list: the current source in
 * plain language, and one quiet way to change it. "Change" reopens the SAME
 * provider picker the Connect flow uses (design §2 item 4) — there is exactly
 * one picker in the product, and this section injects it rather than growing a
 * second one that would drift.
 *
 * @module features/settings/ui/runtimes/sections/PowerSourceSection
 */
import { useState } from 'react';
import { runtimeDisplayName } from '@dorkos/shared/agent-runtime';
import { Button } from '@/layers/shared/ui';
import { useRuntimeRequirements, type RuntimeConnectSlot } from '@/layers/entities/runtime';
import { describePowerSource, renderRuntimeConnect } from '@/layers/features/runtime-connect';

/**
 * The power-source section as pure props — the showcaseable half.
 *
 * Split from its container for the same reason `RuntimeSetupPanel` is split from
 * `RuntimeSetupDialog`: the dev playground has to show a set source and an unset
 * one side by side, which a hook-coupled component can only do one at a time.
 *
 * There is deliberately no `onDone` callback. Every connect path already
 * invalidates the requirements query when it lands, so the current-source line
 * refreshes itself; a second notification channel would be a second thing to
 * keep correct.
 */
export function PowerSourceSectionView({
  type,
  provider,
  renderConnect,
}: {
  /** The runtime this section belongs to, e.g. `'opencode'`. */
  type: string;
  /**
   * The connected provider id (`'ollama'`, `'openrouter'`, `'openai'`…), or
   * undefined when DorkOS did not set one — see the empty state below.
   */
  provider?: string;
  /** The feature-supplied connect renderer that draws the provider picker. */
  renderConnect: RuntimeConnectSlot;
}) {
  const [changing, setChanging] = useState(false);

  return (
    <section
      className="bg-muted/30 space-y-3 rounded-lg border p-3"
      data-testid="power-source-section"
    >
      <div className="flex items-center justify-between gap-3">
        <h4 className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
          Power source
        </h4>
        {provider && !changing && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground h-auto px-1 py-0 text-xs"
            onClick={() => setChanging(true)}
            data-testid="power-source-change"
          >
            Change
          </Button>
        )}
      </div>

      {provider ? (
        <p className="text-sm font-medium" data-testid="power-source-current">
          {describePowerSource(provider)}
        </p>
      ) : (
        // No dead "Change" button here: with no provider on record there is
        // nothing for the picker to change FROM, and the picker's "Currently:"
        // line would be blank. The same rule already governs the quiet Change
        // affordance beside the Ready badge.
        <p className="text-muted-foreground text-xs" data-testid="power-source-empty">
          {runtimeDisplayName(type)} was signed in outside DorkOS, so DorkOS cannot tell you where
          its models come from.
        </p>
      )}

      {provider && changing && (
        <div className="space-y-2" data-testid="power-source-panel">
          {renderConnect({
            type,
            connect: { kind: 'provider-picker', label: 'Change power source' },
            currentProvider: provider,
            // Collapse the moment the new source lands: the refreshed
            // requirements then name it on the line above.
            onConnected: () => setChanging(false),
          })}
          <button
            type="button"
            onClick={() => setChanging(false)}
            className="text-muted-foreground hover:text-foreground text-xs transition-colors"
            data-testid="power-source-cancel"
          >
            Keep current source
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Where OpenCode's models come from, and how to change it.
 *
 * A boxed sub-section of the OpenCode runtime card, rendered through the
 * kind-keyed section registry because OpenCode's runtime declares it. It owns
 * its own read: the provider is DYNAMIC state from
 * `GET /api/system/requirements`, never from the static capability declaration,
 * and `entities/runtime`'s card view is props-only and cannot reach it.
 */
export function PowerSourceSection({
  type,
}: {
  /** The runtime whose card is rendering this section. */
  type: string;
}) {
  const { data: requirements } = useRuntimeRequirements();
  const provider = requirements?.runtimes[type]?.provider;

  return (
    <PowerSourceSectionView
      type={type}
      {...(provider ? { provider } : {})}
      renderConnect={renderRuntimeConnect}
    />
  );
}
