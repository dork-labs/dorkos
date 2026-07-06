import { useMemo, useState } from 'react';

import { Plug2 } from 'lucide-react';
import {
  FieldCard,
  FieldCardContent,
  Input,
  Skeleton,
  SettingRow,
  SwitchSettingRow,
} from '@/layers/shared/ui';
import {
  useAdapterCatalog,
  useExternalAdapterCatalog,
  useRelayEnabled,
  useToggleAdapter,
  useUpdateAdapterConfig,
} from '@/layers/entities/relay';
import { useBindings } from '@/layers/entities/binding';
import { AdapterSetupWizard, CatalogCard } from '@/layers/features/relay';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { ChannelSettingRow } from './ChannelSettingRow';

interface WizardState {
  open: boolean;
  manifest?: AdapterManifest;
  instanceId?: string;
}

/** Session Delivery config keys with a persisted, bounded numeric value. */
type DeliveryConfigKey = 'maxConcurrent' | 'defaultTimeoutMs';

/** Default values shown when the internal claude-code adapter has no persisted config yet. */
const DELIVERY_CONFIG_DEFAULTS: Record<DeliveryConfigKey, number> = {
  maxConcurrent: 3,
  defaultTimeoutMs: 300000,
};

/** Declared min/max for each Session Delivery field, shared by the inputs and the blur guard. */
const DELIVERY_CONFIG_BOUNDS: Record<DeliveryConfigKey, { min: number; max: number }> = {
  maxConcurrent: { min: 1, max: 20 },
  defaultTimeoutMs: { min: 10000, max: 3600000 },
};

/**
 * Channels tab for the Settings dialog.
 *
 * Shows Active Channels (configured adapter instances with toggles and configure actions),
 * Available Channels (catalog of unconfigured adapter types to add), and Session Delivery
 * (the relay's internal claude-code adapter, which starts agent sessions from incoming
 * relay messages rather than bridging to an external platform).
 */
export function ChannelsTab() {
  const relayEnabled = useRelayEnabled();
  const { data: externalCatalog = [], isLoading } = useExternalAdapterCatalog(relayEnabled);
  const { mutate: toggleAdapter } = useToggleAdapter();
  const { data: bindings = [] } = useBindings();
  const [wizardState, setWizardState] = useState<WizardState>({ open: false });

  // Session delivery: the relay's internal claude-code adapter (not an external
  // channel: it starts DorkOS agent sessions from incoming relay messages).
  const { data: fullCatalog = [] } = useAdapterCatalog(relayEnabled);
  const { mutate: updateConfig } = useUpdateAdapterConfig();
  const claudeCodeEntry = useMemo(
    () =>
      fullCatalog.find(
        (e) => e.manifest.category === 'internal' && e.manifest.type === 'claude-code'
      ),
    [fullCatalog]
  );
  const claudeCodeInstance = claudeCodeEntry?.instances[0];
  const claudeCodeConfig = claudeCodeInstance?.config;

  // Resolved persisted values (falls back to defaults when config is unset): the
  // same values the inputs display, so the blur guard below can compare against them.
  const persistedMaxConcurrent = Number(
    claudeCodeConfig?.maxConcurrent ?? DELIVERY_CONFIG_DEFAULTS.maxConcurrent
  );
  const persistedDefaultTimeout = Number(
    claudeCodeConfig?.defaultTimeoutMs ?? DELIVERY_CONFIG_DEFAULTS.defaultTimeoutMs
  );
  const persistedDeliveryValues: Record<DeliveryConfigKey, number> = {
    maxConcurrent: persistedMaxConcurrent,
    defaultTimeoutMs: persistedDefaultTimeout,
  };

  // Local controlled inputs for the delivery config fields (persisted on blur).
  const [localMaxConcurrent, setLocalMaxConcurrent] = useState<string | null>(null);
  const [localTimeout, setLocalTimeout] = useState<string | null>(null);
  const maxConcurrent = localMaxConcurrent ?? String(persistedMaxConcurrent);
  const defaultTimeout = localTimeout ?? String(persistedDefaultTimeout);

  function handleDeliveryConfigBlur(key: DeliveryConfigKey, value: string) {
    const numVal = Number(value);
    const bounds = DELIVERY_CONFIG_BOUNDS[key];
    const isInBounds = !Number.isNaN(numVal) && numVal >= bounds.min && numVal <= bounds.max;
    const isChanged = numVal !== persistedDeliveryValues[key];

    if (claudeCodeInstance && isInBounds && isChanged) {
      updateConfig({ id: claudeCodeInstance.id, config: { [key]: numVal } });
    }
    if (key === 'maxConcurrent') setLocalMaxConcurrent(null);
    if (key === 'defaultTimeoutMs') setLocalTimeout(null);
  }

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

      {/* Session Delivery — the internal claude-code adapter */}
      {claudeCodeInstance && (
        <section>
          <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
            Session Delivery
          </h3>
          <FieldCard>
            <FieldCardContent>
              <SwitchSettingRow
                label="Deliver to Claude Code"
                description="Start a Claude Code agent session automatically when a relay message arrives"
                checked={claudeCodeInstance.enabled}
                onCheckedChange={(enabled) => toggleAdapter({ id: claudeCodeInstance.id, enabled })}
              />
              <SettingRow
                label="Max concurrent sessions"
                description="Maximum relay-delivered sessions running at the same time"
              >
                <Input
                  type="number"
                  min={DELIVERY_CONFIG_BOUNDS.maxConcurrent.min}
                  max={DELIVERY_CONFIG_BOUNDS.maxConcurrent.max}
                  value={maxConcurrent}
                  onChange={(e) => setLocalMaxConcurrent(e.target.value)}
                  onBlur={(e) => handleDeliveryConfigBlur('maxConcurrent', e.target.value)}
                  className="w-24"
                />
              </SettingRow>
              <SettingRow
                label="Default timeout"
                description="Timeout budget per relay-delivered session, in milliseconds"
              >
                <Input
                  type="number"
                  min={DELIVERY_CONFIG_BOUNDS.defaultTimeoutMs.min}
                  max={DELIVERY_CONFIG_BOUNDS.defaultTimeoutMs.max}
                  value={defaultTimeout}
                  onChange={(e) => setLocalTimeout(e.target.value)}
                  onBlur={(e) => handleDeliveryConfigBlur('defaultTimeoutMs', e.target.value)}
                  className="w-32"
                />
              </SettingRow>
            </FieldCardContent>
          </FieldCard>
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
