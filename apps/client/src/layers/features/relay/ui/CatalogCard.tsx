import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { Plus } from 'lucide-react';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';

const CATEGORY_COLORS: Record<string, string> = {
  messaging: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  automation: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  internal: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200',
  custom: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
};

interface CatalogCardProps {
  manifest: AdapterManifest;
  onAdd: () => void;
}

/**
 * Displays an available adapter type in the catalog.
 *
 * Shows icon, name, category badge, description, and an Add button.
 */
export function CatalogCard({ manifest, onAdd }: CatalogCardProps) {
  return (
    <div className="flex flex-col justify-between rounded-lg border p-4 transition-colors hover:bg-muted/50">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {manifest.iconEmoji && (
            <span className="text-lg" role="img" aria-hidden>
              {manifest.iconEmoji}
            </span>
          )}
          <span className="text-sm font-medium">{manifest.displayName}</span>
          <Badge
            variant="secondary"
            className={CATEGORY_COLORS[manifest.category] ?? ''}
          >
            {manifest.category}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{manifest.description}</p>
      </div>
      <div className="mt-3">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={onAdd}
        >
          <Plus className="mr-1 size-3" />
          Add
        </Button>
      </div>
    </div>
  );
}
