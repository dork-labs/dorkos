import { Route } from 'lucide-react';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  FeatureDisabledState,
} from '@/layers/shared/ui';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { useRelayEnabled, useRelayEventStream } from '@/layers/entities/relay';
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
  const enabled = useRelayEnabled();
  useRelayEventStream(enabled);

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

      {enabled ? (
        <>
          <ClaimFeed enabled={enabled} />
          <RelayHealthBar enabled={enabled} />
          <MessagingConnections enabled={enabled} />
          <MessagePolicyCard />

          {/* Deep enough to be worth keeping, quiet enough not to lead. */}
          <Collapsible>
            <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring rounded-md text-sm font-medium">
              Message history
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-3">
              <ActivityFeed enabled={enabled} />
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
