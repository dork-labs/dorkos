import { useState } from 'react';
import { MoreVertical, Settings, Trash2 } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { Switch } from '@/layers/shared/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/layers/shared/ui/alert-dialog';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';

const STATUS_COLORS: Record<string, string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-gray-400',
  error: 'bg-red-500',
  starting: 'bg-yellow-500',
  stopping: 'bg-yellow-500',
};

const CATEGORY_COLORS: Record<string, string> = {
  messaging: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  automation: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  internal: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
  custom: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
};

interface AdapterCardProps {
  instance: CatalogInstance;
  manifest: AdapterManifest;
  onToggle: (enabled: boolean) => void;
  onConfigure: () => void;
  onRemove: () => void;
}

/** Displays a configured adapter instance with status, toggle, and kebab menu actions. */
export function AdapterCard({ instance, manifest, onToggle, onConfigure, onRemove }: AdapterCardProps) {
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const dotColor = STATUS_COLORS[instance.status.state] ?? 'bg-gray-400';
  const isBuiltinClaude = manifest.type === 'claude-code' && manifest.builtin;

  return (
    <>
      <div className="flex items-center justify-between rounded-lg border p-3">
        <div className="flex items-center gap-3">
          <span className={`h-2 w-2 rounded-full ${dotColor}`} />
          <div>
            <div className="flex items-center gap-2">
              {manifest.iconEmoji && (
                <span className="text-sm" role="img" aria-hidden>
                  {manifest.iconEmoji}
                </span>
              )}
              <span className="text-sm font-medium">
                {instance.status.displayName || instance.id}
              </span>
              <Badge
                variant="secondary"
                className={CATEGORY_COLORS[manifest.category] ?? ''}
              >
                {manifest.category}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground">
              In: {instance.status.messageCount.inbound} | Out: {instance.status.messageCount.outbound}
              {instance.status.errorCount > 0 && ` | Errors: ${instance.status.errorCount}`}
            </div>
            {instance.status.lastError && (
              <div className="mt-1 max-w-[200px] truncate text-xs text-red-500">
                {instance.status.lastError}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Switch checked={instance.enabled} onCheckedChange={onToggle} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="size-7 p-0" aria-label="Adapter actions">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onConfigure}>
                <Settings className="mr-2 size-3.5" />
                Configure
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => setRemoveDialogOpen(true)}
                disabled={isBuiltinClaude}
                className="text-red-600 focus:text-red-600"
              >
                <Trash2 className="mr-2 size-3.5" />
                Remove
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <AlertDialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove adapter</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove &quot;{instance.status.displayName || instance.id}&quot;?
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={onRemove}
              className="bg-red-600 hover:bg-red-700 focus:ring-red-600"
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
