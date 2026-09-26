import { useId, useState, type ReactNode } from 'react';
import { useConnectorConnections } from '@/layers/entities/connectors';
import {
  Button,
  Label,
  QueryErrorState,
  RadioGroup,
  RadioGroupItem,
  Skeleton,
} from '@/layers/shared/ui';
import { AccessCardFrame } from './AccessCardFrame';
import type { AgentAccessCardProps } from './ConnectionAccessCard';

/**
 * Fixed-agent mode without a known account: find it, and ask which one when
 * there are two. Once one is known, hands off to `renderAccess`.
 */
export function AccountChoice({
  props,
  renderAccess,
}: {
  props: AgentAccessCardProps;
  renderAccess: (connectionId: string, onChangeAccount?: () => void) => ReactNode;
}) {
  const titleId = useId();
  const query = useConnectorConnections();
  const accounts = (query.data?.connections ?? []).filter(
    (connection) => connection.toolkit === props.toolkit && connection.lifecycle !== 'disconnected'
  );
  const [picked, setPicked] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);

  const only = accounts.length === 1 ? accounts[0].connectionId : null;
  const connectionId = only ?? chosen;
  if (connectionId) {
    return renderAccess(connectionId, only ? undefined : () => setChosen(null));
  }

  const title = `Which ${props.serviceName} account?`;
  return (
    <AccessCardFrame
      titleId={titleId}
      toolkit={props.toolkit}
      title={title}
      className={props.className}
    >
      {query.isPending ? (
        <Skeleton className="h-16 rounded-lg" aria-label="Loading accounts" />
      ) : query.isError ? (
        <QueryErrorState
          title="Couldn’t load your accounts"
          description="Nothing changed. Try again."
          onRetry={() => void query.refetch()}
          isRetrying={query.isFetching}
        />
      ) : accounts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No {props.serviceName} account is connected yet.
        </p>
      ) : (
        <RadioGroup
          aria-labelledby={titleId}
          value={picked ?? ''}
          onValueChange={setPicked}
          className="gap-2"
        >
          {accounts.map((account) => {
            const id = `${titleId}-${account.connectionId}`;
            return (
              <div
                key={account.connectionId}
                className="bg-muted/40 flex min-h-11 items-center gap-3 rounded-lg px-3"
              >
                <RadioGroupItem id={id} value={account.connectionId} />
                <Label
                  htmlFor={id}
                  className="min-w-0 flex-1 cursor-pointer flex-col items-start gap-0.5 py-2 leading-snug font-normal"
                >
                  <span className="block max-w-full truncate text-sm font-medium">
                    {account.label}
                  </span>
                  {account.identityHint && (
                    <span className="text-muted-foreground block max-w-full truncate text-xs">
                      {account.identityHint}
                    </span>
                  )}
                </Label>
              </div>
            );
          })}
        </RadioGroup>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {props.onSkip && (
          <Button variant="ghost" onClick={props.onSkip}>
            Not now
          </Button>
        )}
        {accounts.length > 1 && (
          <Button disabled={!picked} onClick={() => setChosen(picked)}>
            Continue
          </Button>
        )}
      </div>
    </AccessCardFrame>
  );
}
