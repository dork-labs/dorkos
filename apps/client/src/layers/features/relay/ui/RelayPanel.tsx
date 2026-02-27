import { useState } from 'react';
import { RefreshCw, Route } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { Tabs, TabsList, TabsTrigger, TabsContent, FeatureDisabledState, Skeleton, Button } from '@/layers/shared/ui';
import {
  useRelayEnabled,
  useRelayEventStream,
  useAdapterCatalog,
  useToggleAdapter,
  useRemoveAdapter,
} from '@/layers/entities/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { ActivityFeed } from './ActivityFeed';
import { EndpointList } from './EndpointList';
import { InboxView } from './InboxView';
import { AdapterCard } from './AdapterCard';
import { CatalogCard } from './CatalogCard';
import { AdapterSetupWizard } from './AdapterSetupWizard';

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
  instanceId?: string;
}

interface AdaptersTabProps {
  enabled: boolean;
}

/** Renders configured adapter instances and available adapter types from the catalog. */
function AdaptersTab({ enabled }: AdaptersTabProps) {
  const { data: catalog = [], isLoading } = useAdapterCatalog(enabled);
  const { mutate: toggleAdapter } = useToggleAdapter();
  const { mutate: removeAdapter } = useRemoveAdapter();
  const [wizardState, setWizardState] = useState<WizardState>({ open: false });
  const queryClient = useQueryClient();

  if (isLoading) {
    return (
      <div className="space-y-6 p-4">
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className="space-y-2">
            {[1, 2].map((i) => (
              <Skeleton key={i} className="h-16 w-full rounded-lg" />
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-4 w-32" />
          <div className="grid grid-cols-2 gap-3">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-lg border p-4">
                <Skeleton className="mb-2 h-5 w-24" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="mt-3 h-8 w-full" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // Configured: entries that have at least one instance — flatten to individual cards.
  const configuredCards = catalog.flatMap((entry) =>
    entry.instances.map((inst) => ({ instance: inst, manifest: entry.manifest })),
  );

  // Available: entries with no instances, OR multiInstance entries (can always add more).
  const availableEntries = catalog.filter(
    (entry) => entry.instances.length === 0 || entry.manifest.multiInstance,
  );

  const openWizardForAdd = (manifest: AdapterManifest) => {
    setWizardState({ open: true, manifest });
  };

  const openWizardForConfigure = (manifest: AdapterManifest, instanceId: string) => {
    setWizardState({ open: true, manifest, instanceId });
  };

  // Find the existing instance data for edit mode in the wizard.
  const existingInstance = wizardState.instanceId
    ? catalog
        .flatMap((e) => e.instances)
        .find((inst) => inst.id === wizardState.instanceId)
    : undefined;

  const handleRefresh = () => {
    queryClient.invalidateQueries({ queryKey: ['relay', 'adapters', 'catalog'] });
  };

  return (
    <div className="space-y-6 p-4">
      {/* Configured Adapters */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Configured Adapters
          </h3>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            className="size-7 p-0"
            aria-label="Refresh adapter catalog"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {configuredCards.length === 0 ? (
          <p className="text-sm text-muted-foreground">No adapters configured yet.</p>
        ) : (
          <div className="space-y-2">
            {configuredCards.map(({ instance, manifest }) => (
              <AdapterCard
                key={instance.id}
                instance={instance}
                manifest={manifest}
                onToggle={(newEnabled) => toggleAdapter({ id: instance.id, enabled: newEnabled })}
                onConfigure={() => openWizardForConfigure(manifest, instance.id)}
                onRemove={() => removeAdapter(instance.id)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Available Adapters */}
      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Available Adapters
        </h3>
        {availableEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            All available adapter types are configured.
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {availableEntries.map((entry) => (
              <CatalogCard
                key={entry.manifest.type}
                manifest={entry.manifest}
                onAdd={() => openWizardForAdd(entry.manifest)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Setup Wizard */}
      {wizardState.manifest && (
        <AdapterSetupWizard
          open={wizardState.open}
          onOpenChange={(open) => {
            if (!open) setWizardState({ open: false });
          }}
          manifest={wizardState.manifest}
          existingInstance={existingInstance}
        />
      )}
    </div>
  );
}

/** Main Relay panel — tabs for Activity Feed, Endpoints, and Adapters, with disabled/loading states. */
export function RelayPanel() {
  const relayEnabled = useRelayEnabled();
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);

  // Connect SSE stream when relay is enabled
  useRelayEventStream(relayEnabled);

  if (!relayEnabled) {
    return (
      <FeatureDisabledState
        icon={Route}
        name="Relay"
        description="Relay provides inter-agent messaging. Start DorkOS with relay enabled."
        command="DORKOS_RELAY_ENABLED=true dorkos"
      />
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
        <AdaptersTab enabled={relayEnabled} />
      </TabsContent>
    </Tabs>
  );
}
