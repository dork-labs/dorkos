import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { Plus } from 'lucide-react';
import type { AdapterManifest } from '@dorkos/shared/relay-schemas';
import { getCategoryColorClasses } from '../lib/category-colors';

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
    <div className="hover:bg-muted/50 flex flex-col justify-between rounded-lg border p-4 transition-colors">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          {manifest.iconEmoji && (
            <span className="text-lg" role="img" aria-hidden>
              {manifest.iconEmoji}
            </span>
          )}
          <span className="text-sm font-medium">{manifest.displayName}</span>
          <Badge variant="secondary" className={getCategoryColorClasses(manifest.category)}>
            {manifest.category}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">{manifest.description}</p>
      </div>
      <div className="mt-3">
        <Button variant="outline" size="sm" className="w-full" onClick={onAdd}>
          <Plus className="mr-1 size-3" />
          Add
        </Button>
      </div>
    </div>
  );
}
