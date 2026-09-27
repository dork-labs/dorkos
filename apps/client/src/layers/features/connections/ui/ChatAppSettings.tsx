import { Route } from 'lucide-react';
import {
  useAdapterCatalog,
  useRelayEnabledState,
  useToggleAdapter,
  useUpdateAdapterConfig,
} from '@/layers/entities/relay';
import {
  BoundedNumberInput,
  FeatureDisabledState,
  FieldCard,
  FieldCardContent,
  QueryErrorState,
  SettingRow,
  Skeleton,
  SwitchSettingRow,
} from '@/layers/shared/ui';

/** What the numbers are before anyone has changed them. */
const DEFAULT_MOST_AT_ONCE = 3;
const DEFAULT_TIMEOUT_MS = 300_000;

/** The ranges the delivery config accepts, in the units a person types. */
const MOST_AT_ONCE_BOUNDS = { min: 1, max: 20 };
/** Seconds, not minutes: 10 s and 90 s were settable before and must stay exact. */
const WAIT_SECONDS_BOUNDS = { min: 10, max: 3600 };

/** One second, in the milliseconds the config stores. */
const MS_PER_SECOND = 1000;

/**
 * How chat apps behave when a message arrives, for every chat app at once
 * (Telegram, Slack, a webhook): whether a message starts an agent working
 * straight away, how many chats may run together, and how long a new message
 * waits for a free chat before it is turned away.
 *
 * That last one is `defaultTimeoutMs`, which the delivery uses only as the
 * ceiling on how long a message is held for a free slot. It is not a limit on
 * how long an agent works on a message, so the copy never says it is.
 *
 * The three settings live on the built-in delivery that turns an incoming
 * message into a working agent, so this reads that one entry from the chat app
 * catalog and writes it back. Every state the page used to show is here too:
 * still checking, the check failed, chat apps switched off on this server, and
 * chat apps that failed to start.
 */
export function ChatAppSettings() {
  const relay = useRelayEnabledState();

  if (relay.isLoading) {
    return <Skeleton className="h-40 rounded-lg" aria-label="Loading chat app settings" />;
  }
  if (relay.isError) {
    return (
      <QueryErrorState
        title="Couldn’t check chat apps"
        description="Check that DorkOS is running, then try again."
        onRetry={relay.retry}
        isRetrying={relay.isRetrying}
      />
    );
  }
  if (relay.initError) {
    return (
      <QueryErrorState
        title="Chat apps didn’t start"
        description="Restart DorkOS, then try again."
        onRetry={relay.retry}
        isRetrying={relay.isRetrying}
      />
    );
  }
  if (!relay.enabled) {
    return (
      <FeatureDisabledState
        icon={Route}
        name="Chat apps"
        description="Turn on chat apps so people can reach your agents from Telegram, Slack and other chat apps."
        command="DORKOS_RELAY_ENABLED=true dorkos"
      />
    );
  }
  return <DeliverySettings />;
}

/** The three settings, once chat apps are known to be running. */
function DeliverySettings() {
  const catalog = useAdapterCatalog(true);
  const { mutate: toggle } = useToggleAdapter();
  const { mutate: updateConfig } = useUpdateAdapterConfig();

  if (catalog.isPending) {
    return <Skeleton className="h-40 rounded-lg" aria-label="Loading chat app settings" />;
  }
  if (catalog.isError) {
    return (
      <QueryErrorState
        title="Couldn’t load chat app settings"
        description="Try again. Nothing was changed."
        onRetry={() => void catalog.refetch()}
        isRetrying={catalog.isFetching}
      />
    );
  }

  const delivery = catalog.data.find(
    (entry) => entry.manifest.category === 'internal' && entry.manifest.type === 'claude-code'
  )?.instances[0];
  if (!delivery) {
    return (
      <p className="text-muted-foreground text-sm">
        This server has no way to start agents from chat messages, so there is nothing to set here.
      </p>
    );
  }

  const mostAtOnce = Number(delivery.config?.maxConcurrent ?? DEFAULT_MOST_AT_ONCE);
  const timeoutMs = Number(delivery.config?.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);

  return (
    <FieldCard>
      <FieldCardContent>
        <SwitchSettingRow
          label="Start working right away"
          description="A new message puts the agent to work straight away."
          checked={delivery.enabled}
          onCheckedChange={(enabled) => toggle({ id: delivery.id, enabled })}
        />
        <SettingRow label="Most chats at once" description="More wait their turn.">
          <BoundedNumberInput
            aria-label="Most chats at once"
            value={mostAtOnce}
            min={MOST_AT_ONCE_BOUNDS.min}
            max={MOST_AT_ONCE_BOUNDS.max}
            onCommit={(next) => updateConfig({ id: delivery.id, config: { maxConcurrent: next } })}
          />
        </SettingRow>
        <SettingRow
          label="Give up after"
          description="Seconds a new message waits for a free chat before it's turned away."
        >
          <BoundedNumberInput
            aria-label="Give up after, in seconds"
            value={Math.round(timeoutMs / MS_PER_SECOND)}
            min={WAIT_SECONDS_BOUNDS.min}
            max={WAIT_SECONDS_BOUNDS.max}
            onCommit={(seconds) =>
              updateConfig({
                id: delivery.id,
                config: { defaultTimeoutMs: seconds * MS_PER_SECOND },
              })
            }
          />
        </SettingRow>
      </FieldCardContent>
    </FieldCard>
  );
}
