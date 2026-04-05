import { useMemo, useState } from 'react';
import { Plug2 } from 'lucide-react';
import { FieldCard, FieldCardContent, Skeleton } from '@/layers/shared/ui';
import { useAdapterCatalog, useToggleAdapter } from '@/layers/entities/relay';
import { useRelayEnabled } from '@/layers/entities/relay';
import { useBindings } from '@/layers/entities/binding';
import { AdapterSetupWizard, CatalogCard } from '@/layers/features/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { ChannelSettingRow } from './ChannelSettingRow';

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
  instanceId?: string;
}

/**
 * Channels tab for the Settings dialog.
 *
 * Shows Active Channels (configured adapter instances with toggles and configure actions)
 * and Available Channels (catalog of unconfigured adapter types to add).
 */
export function ChannelsTab() {
  const relayEnabled = useRelayEnabled();
  const { data: catalog = [], isLoading } = useAdapterCatalog(relayEnabled);
  const { mutate: toggleAdapter } = useToggleAdapter();
  const { data: bindings = [] } = useBindings();
  const [wizardState, setWizardState] = useState<WizardState>({ open: false });

  // Exclude internal adapters (e.g. claude-code) — they belong on the Agents tab.
  const externalCatalog = useMemo(
    () => catalog.filter((entry) => entry.manifest.category !== 'internal'),
    [catalog]
  );

  // Count bound agents per adapter instance for the metadata line.
  const bindingCountByAdapter = useMemo(() => {
    const counts = new Map<string, number>();
    for (const b of bindings) {
      counts.set(b.adapterId, (counts.get(b.adapterId) ?? 0) + 1);
    }
    return counts;
  }, [bindings]);

  if (!relayEnabled) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-8">
        <Plug2 className="text-muted-foreground/40 size-8" />
        <div className="text-center">
          <p className="text-muted-foreground text-sm">Relay is disabled</p>
          <p className="text-muted-foreground/60 text-xs">
            Enable the Relay message bus to manage channels here
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-10 w-full rounded-md" />
        ))}
      </div>
    );
  }

  // Configured: entries with at least one instance — flatten to individual rows.
  const configuredChannels = externalCatalog.flatMap((entry) =>
    entry.instances.map((instance) => ({ instance, manifest: entry.manifest }))
  );

  // Available: non-deprecated entries with no instances, or multiInstance entries (can add more).
  const availableEntries = externalCatalog.filter(
    (entry) =>
      !entry.manifest.deprecated && (entry.instances.length === 0 || entry.manifest.multiInstance)
  );

  const openWizardForAdd = (manifest: AdapterManifest) => {
    setWizardState({ open: true, manifest });
  };

  const openWizardForConfigure = (manifest: AdapterManifest, instanceId: string) => {
    setWizardState({ open: true, manifest, instanceId });
  };

  // Find the existing instance data for edit mode in the wizard.
  const existingInstance = wizardState.instanceId
    ? externalCatalog.flatMap((e) => e.instances).find((inst) => inst.id === wizardState.instanceId)
    : undefined;

  return (
    <>
      {/* Active Channels */}
      {configuredChannels.length > 0 ? (
        <FieldCard>
          <FieldCardContent>
            {configuredChannels.map(({ instance, manifest }) => (
              <ChannelSettingRow
                key={instance.id}
                instance={instance}
                manifest={manifest}
                bindingCount={bindingCountByAdapter.get(instance.id) ?? 0}
                onToggle={(enabled) => toggleAdapter({ id: instance.id, enabled })}
                onConfigure={() => openWizardForConfigure(manifest, instance.id)}
              />
            ))}
          </FieldCardContent>
        </FieldCard>
      ) : (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed py-8">
          <Plug2 className="text-muted-foreground/40 size-8" />
          <div className="text-center">
            <p className="text-muted-foreground text-sm">No channels configured</p>
            <p className="text-muted-foreground/60 text-xs">
              Add a channel below to connect agents to external platforms
            </p>
          </div>
        </div>
      )}

      {/* Available Channels */}
      {availableEntries.length > 0 && (
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
            Available Channels
          </h3>
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}
          >
            {availableEntries.map((entry) => (
              <CatalogCard
                key={entry.manifest.type}
                manifest={entry.manifest}
                onAdd={() => openWizardForAdd(entry.manifest)}
              />
            ))}
          </div>
        </section>
      )}

      {wizardState.manifest && (
        <AdapterSetupWizard
          open={wizardState.open}
          onOpenChange={(open) => {
            if (!open) setWizardState({ open: false });
          }}
          manifest={wizardState.manifest}
          existingInstance={existingInstance}
          existingAdapterIds={externalCatalog.flatMap((e) => e.instances.map((i) => i.id))}
        />
      )}
    </>
  );
}
