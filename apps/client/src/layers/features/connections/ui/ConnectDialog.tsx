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
import { accountDisplayName } from '../lib/presentation';

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
 * The connect flow dialog: recommendation routing (a purpose-built relay
 * adapter deep-links to the relay surface; a gateway starts the flow), an
 * optional account label, then the consent sequence — the server's custody
 * disclosure is rendered BEFORE the sign-in link opens anything, polling runs
 * only after the person opens it, and the new account is confirmed in place.
 *
 * @param props - The service to connect and the close handler.
 */
export function ConnectDialog({ service, onClose }: ConnectDialogProps) {
  const flow = useConnectFlow();
  const open = service !== null;

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      flow.reset();
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
  return (
    <>
      <ResponsiveDialogHeader>
        <ResponsiveDialogTitle>Connect {service.displayName}</ResponsiveDialogTitle>
        <ResponsiveDialogDescription>
          {state.step === 'connected'
            ? 'Connected and ready to use.'
            : `Link a ${service.displayName} account so your agents can act for you.`}
        </ResponsiveDialogDescription>
      </ResponsiveDialogHeader>
      <ResponsiveDialogBody className="pb-4">
        {(state.step === 'idle' || state.step === 'starting') && (
          <ConnectSetupStep service={service} flow={flow} onClose={onClose} />
        )}
        {state.step === 'disclosure' && <ConnectDisclosureStep flow={flow} />}
        {state.step === 'waiting' && <ConnectWaitingStep flow={flow} />}
        {state.step === 'connected' && (
          <ConnectConnectedStep service={service} flow={flow} onClose={onClose} />
        )}
        {state.step === 'failed' && <ConnectFailedStep flow={flow} onClose={onClose} />}
      </ResponsiveDialogBody>
    </>
  );
}

/**
 * The pre-flight step: route the service (relay adapter first), then take the
 * optional account label and start the flow.
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

  // A purpose-built relay adapter is the richer path — lead with it and let
  // the person choose the generic connector deliberately.
  if (relayRec && !useGatewayAnyway) {
    return (
      <div className="space-y-3">
        <p className="text-sm leading-relaxed">{relayRec.reason}</p>
        <div className="flex flex-col gap-2">
          <Button
            onClick={() => {
              onClose();
              // The relay dialog is deep-linked via its `?relay=open` search
              // param, available on every route (dialog-search-schema).
              void navigate({ to: '.', search: (prev) => ({ ...prev, relay: 'open' }) });
            }}
            className="gap-1.5"
          >
            Open the {service.displayName} adapter
            <ArrowUpRight className="size-4" aria-hidden />
          </Button>
          {providerRec && (
            <Button variant="ghost" size="sm" onClick={() => setUseGatewayAnyway(true)}>
              Use the generic connector instead
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!providerRec) {
    return (
      <p className="text-muted-foreground text-sm">
        Nothing can connect {service.displayName} yet. Add a provider key under Providers first.
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
            ? `You already have a ${service.displayName} account connected — a label tells them apart.`
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

/** The polling step: the flow is checked until the vendor confirms or refuses. */
function ConnectWaitingStep({ flow }: { flow: ReturnType<typeof useConnectFlow> }) {
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="border-muted-foreground/30 border-t-foreground size-4 shrink-0 animate-spin rounded-full border-2"
        />
        <p className="text-sm">Waiting for you to finish signing in…</p>
      </div>
      <Button variant="ghost" size="sm" onClick={() => flow.reset()}>
        Cancel
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
