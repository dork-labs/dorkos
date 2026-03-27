import { RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
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
      onSuccess: () => {
        toast.info('Extension changed — reload the page to apply', {
          action: {
            label: 'Reload now',
            onClick: () => location.reload(),
          },
        });
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

  return (
    <div className="space-y-4">
      <p className="text-muted-foreground text-sm">
        Extensions add new UI and capabilities to DorkOS. Place them in{' '}
        <code className="bg-muted rounded px-1">~/.dork/extensions/</code> or{' '}
        <code className="bg-muted rounded px-1">.dork/extensions/</code> in your project.
      </p>

      {extensions.length === 0 ? (
        <div className="text-muted-foreground py-8 text-center text-sm" data-testid="no-extensions">
          <p>No extensions installed.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {extensions.map((ext) => (
            <ExtensionCard
              key={ext.id}
              extension={ext}
              onToggle={handleToggle}
              isToggling={togglingIds.has(ext.id)}
            />
          ))}
        </div>
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
