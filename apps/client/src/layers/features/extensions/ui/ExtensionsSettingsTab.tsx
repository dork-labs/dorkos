import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import {
  useExtensions,
  useEnableExtension,
  useDisableExtension,
  useReloadExtensions,
} from '../api/queries';
import { ExtensionCard } from './ExtensionCard';

/** Extensions tab in the Settings dialog — manage discovered extensions. */
export function ExtensionsSettingsTab() {
  const { data: extensions = [], isLoading } = useExtensions();
  const enableMutation = useEnableExtension();
  const disableMutation = useDisableExtension();
  const reloadMutation = useReloadExtensions();

  const togglingIds = new Set([
    ...(enableMutation.variables ? [enableMutation.variables] : []),
    ...(disableMutation.variables ? [disableMutation.variables] : []),
  ]);

  async function handleToggle(id: string, enabled: boolean) {
    const mutation = enabled ? enableMutation : disableMutation;

    mutation.mutate(id, {
      onSuccess: (result) => {
        // The server broadcasts `extension_reloaded`, so the change applies live
        // (contributions are hot-loaded/removed via the SSE handler) — no page
        // reload needed.
        const name = result.extension.manifest.name;
        toast.success(`${enabled ? 'Enabled' : 'Disabled'} ${name}`);
      },
      onError: (err) => {
        const action = enabled ? 'enable' : 'disable';
        toast.error(`Failed to ${action} extension: ${err.message}`);
      },
    });
  }

  function handleReload() {
    reloadMutation.mutate(undefined, {
      onSuccess: (updated) => {
        toast.success(`Reloaded ${updated.length} extension(s)`);
      },
      onError: () => {
        toast.error('Failed to reload extensions');
      },
    });
  }

  if (isLoading) {
    return (
      <div className="text-muted-foreground py-8 text-center text-sm">Loading extensions…</div>
    );
  }

  // Partition by origin: first-party "core" extensions vs user-installed ones.
  const coreExtensions = extensions.filter((e) => e.origin === 'core');
  const userExtensions = extensions.filter((e) => e.origin === 'user');

  const renderCard = (ext: ExtensionRecordPublic) => (
    <ExtensionCard
      key={ext.id}
      extension={ext}
      onToggle={handleToggle}
      isToggling={togglingIds.has(ext.id)}
    />
  );

  return (
    <div className="space-y-6">
      <p className="text-muted-foreground text-sm">
        Extensions add new UI and capabilities to DorkOS. Core extensions ship with DorkOS;
        installed extensions live in{' '}
        <code className="bg-muted rounded px-1">~/.dork/extensions/</code> or{' '}
        <code className="bg-muted rounded px-1">.dork/extensions/</code> in your project.
      </p>

      {extensions.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm" data-testid="no-extensions">
          <p>No extensions installed.</p>
        </div>
      ) : (
        <>
          {coreExtensions.length > 0 && (
            <section className="space-y-3" data-testid="core-extensions-section">
              <h3 className="text-sm font-semibold">Core extensions</h3>
              <div className="space-y-3">{coreExtensions.map(renderCard)}</div>
            </section>
          )}

          <section className="space-y-3" data-testid="installed-extensions-section">
            <h3 className="text-sm font-semibold">Installed extensions</h3>
            {userExtensions.length > 0 ? (
              <div className="space-y-3">{userExtensions.map(renderCard)}</div>
            ) : (
              <div
                className="text-muted-foreground rounded-xl border border-dashed p-4 text-sm"
                data-testid="no-installed-extensions"
              >
                No extensions installed yet. Browse{' '}
                <span className="text-foreground font-medium">Dork Hub</span> to add some.
              </div>
            )}
          </section>
        </>
      )}

      <div className="flex justify-end">
        <Button
          variant="outline"
          size="sm"
          onClick={handleReload}
          disabled={reloadMutation.isPending}
          data-testid="reload-extensions-button"
        >
          <RefreshCw className={cn('mr-2 size-4', reloadMutation.isPending && 'animate-spin')} />
          Reload Extensions
        </Button>
      </div>
    </div>
  );
}
