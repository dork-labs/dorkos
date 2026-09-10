import { Route } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FeatureDisabledState,
  QueryErrorState,
  Skeleton,
} from '@/layers/shared/ui';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { useRelayEnabledState, useRelayEventStream } from '@/layers/entities/relay';
import { MessagingConnections, ActivityFeed, RelayHealthBar } from '@/layers/features/relay';
import { ClaimFeed, MessagePolicyCard } from '@/layers/features/connections';

/**
 * Where people and platforms reach your agents.
 *
 * One of the page's two halves, and the one with its own consent story: who
 * may write to your agents, and what happens when someone you never set up
 * does. Chats with nobody to answer them lead, because they are the only part
 * of this page that is waiting on a decision.
 */
export function MessagingRegion() {
  const relay = useRelayEnabledState();
  useRelayEventStream(relay.enabled);

  return (
    <section
      aria-labelledby="region-messaging"
      data-testid={TOUR_ANCHORS.relayIntegrations}
      className="space-y-6"
    >
      <header>
        <h2 id="region-messaging" className="text-base font-semibold">
          Messaging
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          Where people and platforms reach your agents.
        </p>
      </header>

      {relay.isLoading ? (
        <div className="space-y-3" aria-label="Loading Messaging">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : relay.isError ? (
        <QueryErrorState
          title="Couldn’t check Messaging"
          description="Check that DorkOS is running, then try again."
          onRetry={relay.retry}
          isRetrying={relay.isRetrying}
        />
      ) : relay.initError ? (
        <QueryErrorState
          title="Messaging didn’t start"
          description="Restart DorkOS, then try again."
          onRetry={relay.retry}
          isRetrying={relay.isRetrying}
        />
      ) : relay.enabled ? (
        <>
          <ClaimFeed enabled={relay.enabled} />
          <RelayHealthBar enabled={relay.enabled} />
          <MessagingConnections enabled={relay.enabled} />
          <MessagePolicyCard />

          {/* Deep enough to be worth keeping, quiet enough not to lead. */}
          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring rounded-md text-sm font-medium">
              Message history
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <ActivityFeed enabled={relay.enabled} />
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <FeatureDisabledState
          icon={Route}
          name="Messaging"
          description="Turn on Messaging so people can reach your agents from Telegram, Slack and elsewhere."
          command="DORKOS_RELAY_ENABLED=true dorkos"
        />
      )}
    </section>
  );
}
