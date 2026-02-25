import { useState } from 'react';
import { Loader2, Route } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/layers/shared/ui';
import { useRelayEnabled, useRelayEventStream, useRelayAdapters, useToggleAdapter } from '@/layers/entities/relay';
import type { AdapterListItem } from '@dorkos/shared/transport';
import { ActivityFeed } from './ActivityFeed';
import { EndpointList } from './EndpointList';
import { InboxView } from './InboxView';
import { AdapterCard } from './AdapterCard';

interface AdaptersTabProps {
  adapters: AdapterListItem[];
  isLoading: boolean;
  onToggle: (id: string, enabled: boolean) => void;
}

function AdaptersTab({ adapters, isLoading, onToggle }: AdaptersTabProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (adapters.length === 0) {
    return (
      <div className="p-8 text-center text-sm text-muted-foreground">
        No adapters configured.
      </div>
    );
  }

  return (
    <div className="space-y-2 p-4">
      {adapters.map((item) => (
        <AdapterCard
          key={item.config.id}
          item={item}
          onToggle={(enabled) => onToggle(item.config.id, enabled)}
        />
      ))}
    </div>
  );
}

/** Main Relay panel — tabs for Activity Feed, Endpoints, and Adapters, with disabled/loading states. */
export function RelayPanel() {
  const relayEnabled = useRelayEnabled();
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);
  const { data: adapters = [], isLoading: adaptersLoading } = useRelayAdapters(relayEnabled);
  const { mutate: toggleAdapter } = useToggleAdapter();

  // Connect SSE stream when relay is enabled
  useRelayEventStream(relayEnabled);

  if (!relayEnabled) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Route className="size-8 text-muted-foreground/50" />
        <div>
          <p className="font-medium">Relay is not enabled</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Relay provides inter-agent messaging. Start DorkOS with relay enabled.
          </p>
        </div>
        <code className="mt-2 rounded-md bg-muted px-3 py-1.5 font-mono text-sm">
          DORKOS_RELAY_ENABLED=true dorkos
        </code>
      </div>
    );
  }

  return (
    <Tabs defaultValue="activity" className="flex h-full flex-col">
      <TabsList className="mx-4 mt-3 shrink-0">
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="endpoints">Endpoints</TabsTrigger>
        <TabsTrigger value="adapters">Adapters</TabsTrigger>
      </TabsList>

      <TabsContent value="activity" className="min-h-0 flex-1 overflow-y-auto">
        <ActivityFeed enabled={relayEnabled} />
      </TabsContent>

      <TabsContent value="endpoints" className="min-h-0 flex-1 overflow-y-auto">
        {selectedEndpoint ? (
          <InboxView subject={selectedEndpoint} onBack={() => setSelectedEndpoint(null)} />
        ) : (
          <EndpointList enabled={relayEnabled} onSelectEndpoint={setSelectedEndpoint} />
        )}
      </TabsContent>

      <TabsContent value="adapters" className="min-h-0 flex-1 overflow-y-auto">
        <AdaptersTab
          adapters={adapters}
          isLoading={adaptersLoading}
          onToggle={(id, enabled) => toggleAdapter({ id, enabled })}
        />
      </TabsContent>
    </Tabs>
  );
}
