/**
 * Connect-flow dispatcher (ADR-0318, T1 tasks 2.4/2.5/2.8).
 *
 * Maps a runtime's server `connect.kind` to its terminal-free flow, and adapts
 * it to the entity's {@link RuntimeConnectSlot} so the existing T0 Ready/Connect
 * shell drives every runtime through one entry point:
 * - `login` -> {@link LoginConnect} (Codex + Claude paste-key / delegated login)
 * - `provider-picker` -> {@link OpenCodeProviderPicker} (Local / Gateway / Direct)
 *
 * The `install` kind never reaches here — the entity handles OpenCode's
 * one-click provisioning inline (ADR-0317).
 *
 * Being the one entry point is also what makes it the right place to answer
 * "can this browser connect anything at all" (DOR-1655), and "is DorkOS the
 * default here" (spec `dorkos-account-by-default` §3) — see below. Every
 * surface that opens a runtime's connect step (Settings › Runtimes, the
 * onboarding connect step, the status bar, Run with…) gets both by passing this
 * slot.
 *
 * @module features/runtime-connect/ui/RuntimeConnectFlow
 */
import { useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useLocalCaller } from '@/layers/entities/config';
import {
  getRuntimeDescriptor,
  KeepItLocalNote,
  RemoteSigninNotice,
  useCreditsCaveats,
  useRuntimeCreditsOffer,
  type RuntimeConnectSlot,
  type RuntimeConnectSlotProps,
} from '@/layers/entities/runtime';
import { cn } from '@/layers/shared/lib';
import { useCreditsOfferSlot, useSetCreditsDefault } from '@/layers/shared/model';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/layers/shared/ui';
import { creditsConnectSuccess } from '../lib/connect-success';
import { LoginConnect } from './LoginConnect';
import { DoeInferenceForm } from './DoeInferenceForm';
import { OpenCodeProviderPicker } from './OpenCodeProviderPicker';

/** Render the terminal-free connect flow for a not-ready runtime. */
export function RuntimeConnectFlow({
  type,
  connect,
  currentProvider,
  onConnected,
}: RuntimeConnectSlotProps) {
  const isLocalCaller = useLocalCaller();
  const offer = useRuntimeCreditsOffer(type);
  const renderCreditsOffer = useCreditsOfferSlot();
  const setDefault = useSetCreditsDefault();
  const creditsCaveats = useCreditsCaveats([type]);

  // Every flow of a runtime's OWN ends at a loopback-only endpoint — the
  // delegated login and paste-key for Claude Code and Codex, and OpenCode's
  // OpenRouter key, OAuth start and Ollama detect/pull/provision. So the guard
  // belongs to the DISPATCHER rather than to one flow: put it inside
  // `LoginConnect` and OpenCode's picker still hands a remote browser a set of
  // controls that can only 403 (DOR-1655). Without it, the product contradicts
  // itself two clicks apart: the chat auth-error card says sign-in needs the
  // other computer, and Settings offers a button that says otherwise.
  //
  // DorkOS credits are the exception, and the same one on every surface: the
  // link is approved on dorkos.ai and the choice is an account write the
  // owner may make from anywhere, so a phone is offered credits too, with the
  // notice standing in for the runtime's own ways.
  if (type === 'doe')
    return isLocalCaller ? <DoeInferenceForm onConnected={onConnected} /> : <RemoteSigninNotice />;

  const lead = offer === 'lead' && renderCreditsOffer !== null;
  const ownWays = !isLocalCaller ? (
    <RemoteSigninNotice />
  ) : connect.kind === 'provider-picker' ? (
    <OpenCodeProviderPicker currentProvider={currentProvider} onConnected={onConnected} />
  ) : connect.kind === 'login' ? (
    <LoginConnect type={type} onConnected={onConnected} asOtherWay={lead} />
  ) : null;
  if (ownWays === null) return null;

  const label = getRuntimeDescriptor(type).label;
  // A runtime that can run a model on this computer is told so by name.
  const ollama = connect.kind === 'provider-picker';

  // Its new work already runs on credits: that is a working setup, so it says
  // so and offers no card. Its own ways stay one tap away (a repeat visit).
  if (offer === 'on-credits') {
    return (
      <div className="space-y-3" data-testid={`credits-ready-${type}`}>
        <div role="status">
          <p className="text-status-success-fg flex items-center gap-1.5 text-sm font-medium">
            <Check className="size-3.5" aria-hidden />
            You’re ready
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            New work on {label} runs on your DorkOS credits.
            {creditsCaveats.map((caveat) => ` ${caveat}`).join('')}
          </p>
        </div>
        <OtherWays collapsed>{ownWays}</OtherWays>
      </div>
    );
  }

  // Nothing works yet and credits reach this runtime: DorkOS first, the
  // runtime's own ways as visible rows right under it (a first visit), and the
  // line that nothing has to leave this computer.
  const creditsOffer = (fullWidth: boolean) =>
    renderCreditsOffer?.({
      runtime: type,
      origin: `runtime-connect:${type}`,
      fullWidth,
      onChoose: async () => {
        await setDefault.mutateAsync({ runtime: type, useCredits: true });
        onConnected?.(creditsConnectSuccess(label));
      },
    });

  if (lead) {
    return (
      <div className="space-y-4" data-testid={`default-first-${type}`}>
        {creditsOffer(true)}
        <OtherWays>{ownWays}</OtherWays>
        <KeepItLocalNote ollama={ollama} remote={!isLocalCaller} />
      </div>
    );
  }

  // The person turned credits off for this runtime: their own ways lead, and
  // credits stay one quiet row under them.
  if (offer === 'other-way' && renderCreditsOffer !== null) {
    return (
      <div className="space-y-4" data-testid={`credits-other-way-${type}`}>
        {ownWays}
        <OtherWays>{creditsOffer(false)}</OtherWays>
      </div>
    );
  }

  return ownWays;
}

/**
 * The runtime's own ways under a DorkOS default: shown as short rows on a
 * first visit, folded behind one quiet "Other ways" on a repeat one.
 */
function OtherWays({ collapsed = false, children }: { collapsed?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!collapsed);
  if (!collapsed) {
    return (
      <section className="space-y-2" aria-label="Other ways">
        <p className="text-muted-foreground text-2xs font-medium tracking-wide uppercase">
          Other ways
        </p>
        {children}
      </section>
    );
  }
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs transition-colors">
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
        Other ways
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3">{children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The {@link RuntimeConnectSlot} implementation injected into the entity
 * `RuntimeSetupDialog` / `RuntimeSetupPanel`. Passing this from a feature-layer
 * consumer wires the native connect flows into the T0 shell without the entity
 * ever importing a feature.
 */
export const renderRuntimeConnect: RuntimeConnectSlot = (props) => (
  <RuntimeConnectFlow {...props} />
);
