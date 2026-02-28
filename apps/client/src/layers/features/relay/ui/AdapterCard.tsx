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
import { cn } from '@/layers/shared/lib';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';
import { getStatusBorderColor } from '../lib/status-colors';

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
  const borderColor = getStatusBorderColor(instance.status.state);
  const isBuiltinClaude = manifest.type === 'claude-code' && manifest.builtin;
  const displayName = instance.status.displayName || instance.id;

  return (
    <>
      <div
        className={cn(
          'flex items-center justify-between rounded-lg border border-l-2 p-3',
          'hover:shadow-sm transition-shadow',
          borderColor,
        )}
      >
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              {manifest.iconEmoji && (
                <span className="text-sm" role="img" aria-hidden>
                  {manifest.iconEmoji}
                </span>
              )}
              <span className="text-sm font-medium">{displayName}</span>
              <Badge
                variant="secondary"
                className={CATEGORY_COLORS[manifest.category] ?? ''}
              >
                {manifest.category}
              </Badge>
              {isBuiltinClaude && (
                <Badge variant="outline" className="text-xs">
                  System
                </Badge>
              )}
            </div>
            {isBuiltinClaude && (
              <p className="text-xs text-muted-foreground">
                Handles: Chat messages, Pulse jobs
              </p>
            )}
            <div className="text-xs text-muted-foreground/70">
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
              Are you sure you want to remove &quot;{displayName}&quot;? This will stop the adapter
              and remove its configuration. Messages to its subjects will no longer be delivered.
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
