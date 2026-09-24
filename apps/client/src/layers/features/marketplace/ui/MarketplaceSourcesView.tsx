'use client';

import { useState } from 'react';
import { Plus, Trash2, Circle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
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
  PageHeading,
  Skeleton,
} from '@/layers/shared/ui';
import {
  useAddMarketplaceSource,
  useMarketplaceSources,
  useRefreshMarketplaceSource,
  useRemoveMarketplaceSource,
} from '@/layers/entities/marketplace';

/** "12 packages are ready to install." — the success line add and refresh share. */
function packagesReady(count: number): string {
  return count === 1 ? '1 package is ready to install.' : `${count} packages are ready to install.`;
}

/** End a server reason with exactly one full stop. */
function sentence(reason: string): string {
  return `${reason.replace(/\.+$/, '')}.`;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface SourceCardProps {
  name: string;
  source: string;
  enabled: boolean;
  addedAt: string;
  /** Why this source's packages aren't loaded, when a fetch of them just failed. */
  listingNote: string | null;
  onRefresh: () => void;
  isRefreshing: boolean;
  onRemove: () => void;
  isRemoving: boolean;
}

function SourceCard({
  name,
  source,
  enabled,
  addedAt,
  listingNote,
  onRefresh,
  isRefreshing,
  onRemove,
  isRemoving,
}: SourceCardProps) {
  const addedDate = new Date(addedAt).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

  return (
    <div
      data-slot="source-card"
      className="bg-card flex items-start justify-between gap-4 rounded-xl border p-5"
    >
      <div className="flex min-w-0 items-start gap-3">
        <Circle
          className={`mt-0.5 size-3 shrink-0 fill-current ${enabled ? 'text-emerald-500' : 'text-muted-foreground'}`}
          aria-label={enabled ? 'Enabled' : 'Disabled'}
        />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{name}</p>
          <p className="text-muted-foreground truncate text-xs">{source}</p>
          <p className="text-muted-foreground mt-1 text-xs">Added {addedDate}</p>
          {listingNote && (
            <p role="status" className="mt-2 text-xs text-amber-700 dark:text-amber-400">
              {listingNote}
            </p>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label={`Refresh ${name}`}
        >
          <RefreshCw className={`size-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span className="ml-1.5 hidden sm:inline">Refresh</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={isRemoving}
          className="text-destructive hover:text-destructive"
          aria-label={`Remove ${name}`}
        >
          <Trash2 className="size-3.5" />
          <span className="ml-1.5 hidden sm:inline">Remove</span>
        </Button>
      </div>
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
  const refreshSource = useRefreshMarketplaceSource();
  const [dialogOpen, setDialogOpen] = useState(false);
  // Why a source's packages didn't load, by source name. Kept only for this
  // visit: the server fetches on add and on refresh, and says why at the time.
  const [listingNotes, setListingNotes] = useState<Record<string, string>>({});

  const setListingNote = (name: string, note: string | null) => {
    setListingNotes(({ [name]: _dropped, ...rest }) => (note ? { ...rest, [name]: note } : rest));
  };

  // Adding a source fetches its listing once (DOR-2304). A failed fetch still
  // saved the source, so the dialog closes either way and the row says what
  // happened — the same outcome `dorkos marketplace add` prints.
  const handleAdd = (name: string, source: string) => {
    addSource.mutate(
      { name, source, enabled: true },
      {
        onSuccess: (added) => {
          setDialogOpen(false);
          if (added.listing.fetched) {
            setListingNote(added.name, null);
            toast.success(`Added ${added.name}. ${packagesReady(added.listing.packageCount)}`);
          } else {
            setListingNote(
              added.name,
              `Added, but its packages didn't load: ${sentence(added.listing.reason)} Try Refresh.`
            );
          }
        },
      }
    );
  };

  const handleRefresh = (name: string) => {
    refreshSource.mutate(name, {
      onSuccess: (refreshed) => {
        setListingNote(name, null);
        toast.success(`Refreshed ${name}. ${packagesReady(refreshed.marketplace.plugins.length)}`);
      },
      onError: (err) => {
        setListingNote(name, `Its packages didn't load: ${sentence(err.message)} Try Refresh.`);
      },
    });
  };

  const handleRemove = (name: string) => {
    removeSource.mutate(name, { onSuccess: () => setListingNote(name, null) });
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
          <PageHeading>Marketplace sources</PageHeading>
          <p className="text-muted-foreground text-sm">
            Git registries that publish marketplace packages.
          </p>
        </div>
        <Button onClick={() => setDialogOpen(true)} size="sm">
          <Plus className="mr-1.5 size-4" />
          Add marketplace source
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
            Add marketplace source
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
              listingNote={listingNotes[s.name] ?? null}
              onRefresh={() => handleRefresh(s.name)}
              isRefreshing={refreshSource.isPending && refreshSource.variables === s.name}
              onRemove={() => handleRemove(s.name)}
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
