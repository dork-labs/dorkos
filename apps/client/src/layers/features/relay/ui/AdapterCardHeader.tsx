import { Activity, Link2, MoreVertical, Settings, Trash2 } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';
import { Button } from '@/layers/shared/ui/button';
import { Switch } from '@/layers/shared/ui/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/layers/shared/ui/dropdown-menu';
import { cn } from '@/layers/shared/lib';
import type { AdapterManifest, CatalogInstance } from '@dorkos/shared/relay-schemas';
import { getCategoryColorClasses } from '../lib/category-colors';
import { AdapterIcon } from './AdapterIcon';

interface AdapterCardHeaderProps {
  manifest: AdapterManifest;
  instance: CatalogInstance;
  primaryName: string;
  secondaryName: string | null;
  statusDotClass: string;
  onToggle: (enabled: boolean) => void;
  onShowEvents: () => void;
  onConfigure: () => void;
  onRemove: () => void;
  onAddBinding: () => void;
  isBuiltinClaude: boolean;
}

/** Renders the adapter card header: status dot, icon, name, toggle, and kebab dropdown. */
export function AdapterCardHeader({
  manifest,
  instance,
  primaryName,
  secondaryName,
  statusDotClass,
  onToggle,
  onShowEvents,
  onConfigure,
  onRemove,
  onAddBinding,
  isBuiltinClaude,
}: AdapterCardHeaderProps) {
  return (
    <>
      {/* Header row: status dot, icon, name, toggle, kebab */}
      <div className="flex items-start justify-between">
        <div className="flex min-w-0 items-center gap-2.5">
          <div className={statusDotClass} aria-hidden />
          <AdapterIcon
            iconId={manifest.iconId}
            adapterType={manifest.type}
            size={16}
            className="text-muted-foreground shrink-0"
          />
          <span className="text-sm font-medium">{primaryName}</span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Switch checked={instance.enabled} onCheckedChange={onToggle} />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="size-7 p-0" aria-label="Adapter actions">
                <MoreVertical className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onShowEvents}>
                <Activity className="mr-2 size-3.5" />
                Events
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onAddBinding}>
                <Link2 className="mr-2 size-3.5" />
                Add Binding
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onConfigure}>
                <Settings className="mr-2 size-3.5" />
                Configure
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onRemove}
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

      {/* Subtitle: secondary name + category + deprecation badge */}
      <div className="mt-1 flex items-center gap-2 pl-[18px]">
        {secondaryName && <span className="text-muted-foreground text-xs">{secondaryName}</span>}
        {secondaryName && <span className="text-muted-foreground/50 text-xs">&middot;</span>}
        <Badge
          variant="secondary"
          className={cn('text-xs', getCategoryColorClasses(manifest.category))}
        >
          {manifest.category}
        </Badge>
        {manifest.deprecated && (
          <Badge variant="outline" className="text-xs text-amber-600 dark:text-amber-500">
            Deprecated
          </Badge>
        )}
      </div>
    </>
  );
}
