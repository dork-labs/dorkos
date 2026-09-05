import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { ArrowUpRight, CheckCircle2, ExternalLink } from 'lucide-react';
import type { ConnectorToolkit } from '@dorkos/shared/connector-provider';
import {
  Button,
  Input,
  Label,
  ResponsiveDialog,
  ResponsiveDialogBody,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Skeleton,
} from '@/layers/shared/ui';
import {
  useConnectFlow,
  useConnectorAccounts,
  useConnectorRecommendation,
} from '@/layers/entities/connectors';
import { accountDisplayName, providerName } from '../lib/presentation';

/**
 * The label suggested when a service already has one account — makes the
 * multi-account capability visible at exactly the moment it becomes real.
 */
const SUGGESTED_SECOND_LABEL = 'personal';

interface ConnectDialogProps {
  /** The service being connected, or `null` when the dialog is closed. */
  service: ConnectorToolkit | null;
  /** Close the dialog (also called after Done on success). */
  onClose: () => void;
}

/**
 * The connect flow dialog: an intent step for services that are two things at
 * once (Slack is both a place to talk to your agents and an account they can
 * act on), an optional account label, then the consent sequence — the server's
 * custody disclosure is rendered BEFORE the sign-in link opens anything,
 * polling runs only after the person opens it, and the new account is
 * confirmed in place.
 *
 * @param props - The service to connect and the close handler.
 */
export function ConnectDialog({ service, onClose }: ConnectDialogProps) {
  const flow = useConnectFlow();
  const open = service !== null;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // Mid-grant (`waiting`), the vendor tab may still complete the sign-in:
      // keep the flow tracked and polling (the store outlives this dialog, and
      // this hook stays mounted with the page) so the account is recorded even
      // when the person closes the dialog before finishing. Every other step
      // is safe to abandon — nothing has been granted yet, or it is terminal.
      if (flow.state.step !== 'waiting') flow.reset();
      onClose();
    }
  };

  return (
    <ResponsiveDialog open={open} onOpenChange={handleOpenChange}>
      <ResponsiveDialogContent className="sm:max-w-md">
        {service && <ConnectDialogBody service={service} flow={flow} onClose={onClose} />}
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  );
}

/** The dialog's inner content, mounted only while a service is selected. */
function ConnectDialogBody({
  service,
  flow,
  onClose,
}: {
  service: ConnectorToolkit;
  flow: ReturnType<typeof useConnectFlow>;
  onClose: () => void;
}) {
  const { state } = flow;
  // The store holds ONE app-wide flow; show its steps only when it belongs to
  // this service. Opening the dialog for slack while a gmail flow still waits
  // in the background starts fresh (and starting replaces the old tracking).
  const flowOwnsService =
    state.toolkit === service.slug && state.step !== 'idle' && state.step !== 'starting';
  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Connect {service.displayName}</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          {flowOwnsService && state.step === 'connected'
            ? 'Connected and ready to use.'
            : `Link a ${service.displayName} account so your agents can act for you.`}
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="pb-4">
        {!flowOwnsService && <ConnectSetupStep service={service} flow={flow} onClose={onClose} />}
        {flowOwnsService && state.step === 'disclosure' && <ConnectDisclosureStep flow={flow} />}
        {flowOwnsService && state.step === 'waiting' && (
          <ConnectWaitingStep service={service} onClose={onClose} />
        )}
        {flowOwnsService && state.step === 'connected' && (
          <ConnectConnectedStep service={service} flow={flow} onClose={onClose} />
        )}
        {flowOwnsService && state.step === 'failed' && (
          <ConnectFailedStep flow={flow} onClose={onClose} />
        )}
      </ResponsiveDialogBody>
    </>
  );
}

/**
 * The pre-flight step: ask which of the two things this service is being
 * connected for, when it can be both, then take the optional account label and
 * start the flow.
 */
function ConnectSetupStep({
  service,
  flow,
  onClose,
}: {
  service: ConnectorToolkit;
  flow: ReturnType<typeof useConnectFlow>;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const recommendation = useConnectorRecommendation(service.slug);
  const existing = useConnectorAccounts(service.slug);
  // `null` = untouched. The rendered value derives the suggestion from live
  // data, so the pre-fill needs no effect and a person's typing always wins.
  const [labelInput, setLabelInput] = useState<string | null>(null);
  const [useGatewayAnyway, setUseGatewayAnyway] = useState(false);

  const hasAccountAlready = (existing.data?.accounts.length ?? 0) > 0;
  // Multi-account made visible: a second account of one service starts with a
  // suggested label so "Gmail" and "Gmail (personal)" never collide unnamed.
  const label = labelInput ?? (hasAccountAlready ? SUGGESTED_SECOND_LABEL : '');

  if (recommendation.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  }

  if (recommendation.isError) {
    return (
      <p role="alert" className="text-destructive text-sm">
        {recommendation.error.message}
      </p>
    );
  }

  const recs = recommendation.data?.recommendations ?? [];
  const relayRec = recs.find((r) => r.kind === 'relay-adapter');
  const providerRec = recs.find(
    (r) => (r.kind === 'gateway' || r.kind === 'raw-mcp') && r.provider !== undefined
  );

  // Some services are two different things wearing one name. Slack can be a
  // place people talk TO your agents, or an account your agents act on FOR
  // you. Those are different powers with different consent stories, so the
  // choice is asked plainly instead of hidden behind a "use the other one"
  // afterthought.
  if (relayRec && !useGatewayAnyway) {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-relaxed">What do you want {service.displayName} for?</p>
        <div className="flex flex-col gap-2">
          <Button
            onClick={() => {
              onClose();
              void navigate({ to: '/connections', search: { region: 'messaging' } as never });
            }}
            className="h-auto flex-col items-start gap-1 py-3 text-left"
          >
            <span className="flex w-full items-center justify-between gap-2 font-medium">
              Chat with your agents in {service.displayName}
              <ArrowUpRight className="size-4 shrink-0" aria-hidden />
            </span>
            <span className="text-xs font-normal opacity-80">
              Message them from {service.displayName} and get replies there.
            </span>
          </Button>
          {providerRec && (
            <Button
              variant="secondary"
              onClick={() => setUseGatewayAnyway(true)}
              className="h-auto flex-col items-start gap-1 py-3 text-left"
            >
              <span className="w-full font-medium">
                Let agents act on your {service.displayName} account
              </span>
              <span className="text-muted-foreground text-xs font-normal">
                They post and read as you. This one goes through{' '}
                {providerName(providerRec.provider as string)}.
              </span>
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!providerRec) {
    return (
      <p className="text-muted-foreground text-sm">
        {service.displayName} cannot be connected yet. Add a Composio or Nango key further down this
        page first.
      </p>
    );
  }

  const starting = flow.state.step === 'starting';
  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const trimmed = label.trim();
        flow.start({
          provider: providerRec.provider as string,
          toolkit: service.slug,
          ...(trimmed !== '' && { label: trimmed }),
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="connect-account-label" className="text-xs">
          Account label <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="connect-account-label"
          value={label}
          onChange={(e) => setLabelInput(e.target.value)}
          placeholder="e.g. work"
          autoComplete="off"
        />
        <p className="text-muted-foreground text-xs">
          {hasAccountAlready
            ? `You already have a ${service.displayName} account connected. A label tells them apart.`
            : 'A label helps when you later connect a second account of the same service.'}
        </p>
      </div>
      <ResponsiveDialogFooter className="px-0 pb-0">
        <Button type="submit" disabled={starting} className="w-full sm:w-auto">
          {starting ? 'Starting…' : 'Continue'}
        </Button>
      </ResponsiveDialogFooter>
    </form>
  );
}

/**
 * The consent step: the server's custody sentence, rendered before anything
 * opens. The sign-in link is the only way to the vendor page, and it sits
 * under the disclosure — reading order IS the consent order.
 */
function ConnectDisclosureStep({ flow }: { flow: ReturnType<typeof useConnectFlow> }) {
  const { state } = flow;
  return (
    <div className="space-y-4">
      <p
        data-testid="connect-disclosure"
        className="bg-muted rounded-md px-3 py-2.5 text-sm leading-relaxed"
      >
        {state.disclosure}
      </p>
      <div className="space-y-2">
        <Button asChild className="w-full gap-1.5">
          <a
            href={state.authorizeUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => flow.authOpened()}
          >
            Open the sign-in page
            <ExternalLink className="size-4" aria-hidden />
          </a>
        </Button>
        <p className="text-muted-foreground text-center text-xs">
          The sign-in opens in a new tab. Come back here when you are done.
        </p>
      </div>
    </div>
  );
}

/**
 * The polling step: the flow is checked until the vendor confirms or refuses.
 * Deliberately no Cancel — the sign-in may already be completing in the vendor
 * tab, and abandoning tracking here is how a live grant goes unrecorded.
 * Closing merely hides the dialog; the flow keeps polling and the account
 * lands in the list either way (disconnect is always available afterwards).
 */
function ConnectWaitingStep({
  service,
  onClose,
}: {
  service: ConnectorToolkit;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="border-muted-foreground/30 border-t-foreground size-4 shrink-0 animate-spin rounded-full border-2"
        />
        <p className="text-sm">Waiting for you to finish signing in…</p>
      </div>
      <p className="text-muted-foreground text-xs">
        You can close this window. We keep checking, and {service.displayName} will appear in your
        accounts once the sign-in finishes.
      </p>
      <Button variant="ghost" size="sm" onClick={onClose}>
        Close window
      </Button>
    </div>
  );
}

/** The success step: the new account, named and disclosed, one Done away. */
function ConnectConnectedStep({
  service,
  flow,
  onClose,
}: {
  service: ConnectorToolkit;
  flow: ReturnType<typeof useConnectFlow>;
  onClose: () => void;
}) {
  const account = flow.state.account;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <CheckCircle2 className="size-5 text-emerald-500" aria-hidden />
        <p className="text-sm font-medium">
          {account
            ? `${accountDisplayName(service.displayName, account.label)} is connected.`
            : `${service.displayName} is connected.`}
        </p>
      </div>
      {account && (
        <p className="text-muted-foreground text-xs leading-relaxed">{account.disclosure}</p>
      )}
      <ResponsiveDialogFooter className="px-0 pb-0">
        <Button
          onClick={() => {
            flow.reset();
            onClose();
          }}
        >
          Done
        </Button>
      </ResponsiveDialogFooter>
    </div>
  );
}

/** The failure step: the honest error, verbatim, with a way back. */
function ConnectFailedStep({
  flow,
  onClose,
}: {
  flow: ReturnType<typeof useConnectFlow>;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <p role="alert" className="text-destructive text-sm leading-relaxed">
        {flow.state.error ?? 'The connection did not complete.'}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={() => flow.reset()}>
          Try again
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            flow.reset();
            onClose();
          }}
        >
          Close
        </Button>
      </div>
    </div>
  );
}
