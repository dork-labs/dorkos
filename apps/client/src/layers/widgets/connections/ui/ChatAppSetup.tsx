import { useCallback, useState } from 'react';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { useAdapterCatalog, useRelayEnabledState } from '@/layers/entities/relay';
import { AdapterSetupWizard } from '@/layers/features/relay';
import { useOpenConnections } from '@/layers/shared/model';

/**
 * Connect a chat app picked from the app list: straight into its own setup
 * (paste the bot token, then who answers), never the one-time step that sets
 * up how DorkOS reaches apps — chat apps are built in and need none of that.
 *
 * When the chat app cannot be added from here (chat apps are turned off, or it
 * allows one setup and already has it), the page's chat section says why and
 * shows the one already set up, so the choice goes there instead.
 *
 * @returns `open(type)` for the list's chat buttons, and the setup dialog to render.
 */
export function useChatAppSetup() {
  const relay = useRelayEnabledState();
  const catalog = useAdapterCatalog(relay.enabled);
  const openConnections = useOpenConnections();
  const [manifest, setManifest] = useState<AdapterManifest | null>(null);

  const open = useCallback(
    (chatAppType: string) => {
      const entry = relay.enabled
        ? catalog.data?.find((candidate) => candidate.manifest.type === chatAppType)
        : undefined;
      if (entry && (entry.instances.length === 0 || entry.manifest.multiInstance)) {
        setManifest(entry.manifest);
        return;
      }
      openConnections('messaging');
    },
    [catalog.data, openConnections, relay.enabled]
  );

  const dialog = manifest ? (
    <AdapterSetupWizard
      open
      onOpenChange={(next) => {
        if (!next) setManifest(null);
      }}
      manifest={manifest}
      existingAdapterIds={catalog.data?.flatMap((entry) => entry.instances.map((i) => i.id))}
    />
  ) : null;

  return { open, dialog };
}
