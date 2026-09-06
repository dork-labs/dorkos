'use client';

import { useState } from 'react';
import { Plus, Trash2, Circle } from 'lucide-react';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Skeleton,
} from '@/layers/shared/ui';
import {
  useAddMarketplaceSource,
  useMarketplaceSources,
  useRemoveMarketplaceSource,
} from '@/layers/entities/marketplace';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface SourceCardProps {
  name: string;
  source: string;
  enabled: boolean;
  addedAt: string;
  onRemove: () => void;
  isRemoving: boolean;
}

function SourceCard({ name, source, enabled, addedAt, onRemove, isRemoving }: SourceCardProps) {
  const addedDate = new Date(addedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div className="bg-card flex items-start justify-between rounded-xl border p-5">
      <div className="flex items-start gap-3">
        <Circle
          className={`mt-0.5 size-3 shrink-0 fill-current ${enabled ? 'text-emerald-500' : 'text-muted-foreground'}`}
          aria-label={enabled ? 'Enabled' : 'Disabled'}
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-muted-foreground truncate text-xs">{source}</p>
          <p className="text-muted-foreground mt-1 text-xs">Added {addedDate}</p>
        </div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={onRemove}
        disabled={isRemoving}
        className="text-destructive hover:text-destructive ml-4 shrink-0"
        aria-label={`Remove ${name}`}
      >
        <Trash2 className="size-3.5" />
        <span className="ml-1.5 hidden sm:inline">Remove</span>
      </Button>
    </div>
  );
}

interface AddSourceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPending: boolean;
  /** Why the last attempt was refused, or `null` when there was none. */
  error: string | null;
  onSubmit: (name: string, source: string) => void;
}

function AddSourceDialog({ open, onOpenChange, isPending, error, onSubmit }: AddSourceDialogProps) {
  const [name, setName] = useState('');
  const [source, setSource] = useState('');

  const handleSubmit = () => {
    onSubmit(name.trim(), source.trim());
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setName('');
      setSource('');
    }
    onOpenChange(next);
  };

  const isValid = source.trim().length > 0 && name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a marketplace source</DialogTitle>
          <DialogDescription>
            Paste the link to a git repository that publishes marketplace packages, and give it a
            name.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="source-url">Repository link</Label>
            <Input
              id="source-url"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="https://github.com/org/marketplace"
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="source-name">Name</Label>
            <Input
              id="source-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. my-registry"
              autoComplete="off"
            />
          </div>
          {/* The server refuses an address it cannot fetch from and says which
              forms do work (DOR-1710). Without this the dialog just sat there
              on a refusal, which reads as a broken button. */}
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => handleOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!isValid || isPending}>
            {isPending ? 'Adding…' : 'Add source'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

/**
 * Marketplace sources management view.
 *
 * Lists all configured git registries, shows their enabled state and the date
 * they were added, and provides add/remove actions. Mounts at
 * `/marketplace/sources` inside the marketplace feature area.
 *
 * FSD: `features/marketplace` — imports only from `entities/marketplace` and
 * `shared/ui`.
 */
export function MarketplaceSourcesView() {
  const { data: sources, isLoading } = useMarketplaceSources();
  const addSource = useAddMarketplaceSource();
  const removeSource = useRemoveMarketplaceSource();
  const [dialogOpen, setDialogOpen] = useState(false);

  const handleAdd = (name: string, source: string) => {
    addSource.mutate(
      { name, source, enabled: true },
      {
        onSuccess: () => setDialogOpen(false),
      }
    );
  };

  // Closing the dialog drops the last refusal with it — reopening to try again
  // should not open onto the previous attempt's error.
  const handleDialogOpenChange = (next: boolean) => {
    if (!next) {
      addSource.reset();
    }
    setDialogOpen(next);
  };

  const isEmpty = !isLoading && (!sources || sources.length === 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4">
        <div>
          {/* Not drawn (design decision E1): the bar overhead already says
              "Marketplace Sources". Kept for the outline — the bar's title is
              a `nav` landmark, not a heading. */}
          <h1 className="sr-only">Marketplace sources</h1>
          <p className="text-muted-foreground text-sm">
            Git registries that publish marketplace packages.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} size="sm">
          <Plus className="mr-1.5 size-4" />
          Add source
        </Button>
      </div>

      {/* Loading skeleton */}
      {isLoading && (
        <div className="space-y-3">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-20 rounded-xl border" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {isEmpty && (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="text-sm font-medium">No marketplaces added yet</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Add a git registry to browse and install marketplace packages.
          </p>
          <Button className="mt-4" size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1.5 size-4" />
            Add source
          </Button>
        </div>
      )}

      {/* Sources list */}
      {sources && sources.length > 0 && (
        <div className="space-y-3">
          {sources.map((s) => (
            <SourceCard
              key={s.name}
              name={s.name}
              source={s.source}
              enabled={s.enabled}
              addedAt={s.addedAt}
              onRemove={() => removeSource.mutate(s.name)}
              isRemoving={removeSource.isPending}
            />
          ))}
        </div>
      )}

      {/* Add dialog */}
      <AddSourceDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        isPending={addSource.isPending}
        error={addSource.error?.message ?? null}
        onSubmit={handleAdd}
      />
    </div>
  );
}
