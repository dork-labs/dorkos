import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { useAdapterCatalog, useRelayEnabledState } from '@/layers/entities/relay';
import { AdapterSetupWizard } from '@/layers/features/relay';

/**
 * Connect a chat app picked from the app list: straight into its own setup
 * (paste the bot token, then who answers), never the one-time step that sets
 * up how DorkOS reaches apps — chat apps are built in and need none of that.
 *
 * The list only offers a chat app that can be added (chat apps are on, and it
 * allows another setup), so the one refusal left is the chat app list not
 * having arrived yet, which says so rather than doing nothing.
 *
 * @returns `open(type)` for the list's chat rows, and the setup dialog to render.
 */
export function useChatAppSetup() {
  const relay = useRelayEnabledState();
  const catalog = useAdapterCatalog(relay.enabled);
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
      toast.error('Chat apps aren’t ready yet. Try again in a moment.');
    },
    [catalog.data, relay.enabled]
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
