import { useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { ExtensionRecordPublic } from '@dorkos/extension-api';
import { Button, Chip, Input, Skeleton } from '@/layers/shared/ui';
import { cn, openLink } from '@/layers/shared/lib';
import { useDeepLinkScroll, useSettingsDeepLink } from '@/layers/shared/model';
import {
  useExtensions,
  useEnableExtension,
  useDisableExtension,
  useReloadExtensions,
  useSetExtensionRunApproval,
  RunApprovalError,
} from '../api/queries';
import {
  approvedSetOf,
  permissionViewFromRecord,
  useSeenBeforeStaleStore,
  useStepUpRisks,
  usePendingExtensionApprovals,
} from '@/layers/entities/extension';
import {
  isExtensionOff,
  matchesExtensionSearch,
  sectionExtensions,
} from '../lib/extension-row-state';
import { ExtensionRow } from './ExtensionRow';
import { TrustedSourcesSection } from './TrustedSourcesSection';

/** The list's filters. "Not used in 30 days" waits for last-used data. */
type ExtensionFilter = 'all' | 'off';

/**
 * Extensions tab in the Settings dialog: every extension as one line, what
 * needs the person on top, the rest A–Z, and DorkOS's own folded at the end.
 */
export function ExtensionsSettingsTab() {
  const { data, isLoading, isError, isRefetching, refetch } = useExtensions();
  const extensions = useMemo(() => data ?? [], [data]);
  // No answer at all is "couldn't load", never "none installed". A list read
  // once and refused later keeps showing what it had.
  const loadFailed = isError && data === undefined;
  // The mini apps that keep "Confirm it's you" off (DOR-3234).
  const { data: stepUpRisks } = useStepUpRisks();
  // What changed, and since when, for a row waiting for an OK.
  const { approvals } = usePendingExtensionApprovals();
  const [openIds, setOpenIds] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ExtensionFilter>('all');
  const [coreOpen, setCoreOpen] = useState(false);

  function setOpen(id: string, open: boolean) {
    setOpenIds((current) => {
      const next = new Set(current);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  // "Where it shows…" in the right panel opens this tab with the mini app's id
  // as the section: bring its row into view, open, once the list has drawn.
  const { section } = useSettingsDeepLink();
  useDeepLinkScroll(isLoading ? null : section, (id) => {
    setOpen(id, true);
    if (extensions.some((ext) => ext.id === id && ext.origin === 'core')) setCoreOpen(true);
  });
  const enableMutation = useEnableExtension();
  const disableMutation = useDisableExtension();
  const reloadMutation = useReloadExtensions();
  const approveMutation = useSetExtensionRunApproval(true);
  const revokeMutation = useSetExtensionRunApproval(false);

  const togglingIds = new Set([
    ...(enableMutation.variables ? [enableMutation.variables] : []),
    ...(disableMutation.variables ? [disableMutation.variables] : []),
  ]);

  const approvingIds = new Set([
    ...(approveMutation.isPending && approveMutation.variables
      ? [approveMutation.variables.id]
      : []),
    ...(revokeMutation.isPending && revokeMutation.variables ? [revokeMutation.variables.id] : []),
  ]);

  function handleSetRunApproval(id: string, approve: boolean) {
    const mutation = approve ? approveMutation : revokeMutation;
    const shown = extensions.find((ext) => ext.id === id);
    if (!shown) return;

    // Turning it on echoes the permission set the panel lists (DOR-2686).
    const permissions = approve ? approvedSetOf(permissionViewFromRecord(shown)) : undefined;
    mutation.mutate(
      {
        id,
        version: shown.manifest.version,
        plugin: shown.sourcePlugin ?? null,
        ...(permissions ? { permissions } : {}),
        // The files this panel was drawn for (DOR-3068).
        ...(approve && shown.digest ? { expectedDigest: shown.digest } : {}),
      },
      {
        onSuccess: (result) => {
          if (approve) useSeenBeforeStaleStore.getState().forget(id);
          const name = result.extension.manifest.name;
          // "inside DorkOS" only for one that does run inside (DOR-2686).
          const where = result.extension.isolation ? '' : ' inside DorkOS';
          toast.success(approve ? `${name} can now run${where}` : `${name} stopped running`);
        },
        onError: (err) => {
          if (err instanceof RunApprovalError && err.stale) {
            // The redrawn panel leads with what this one did not list.
            if (permissions) useSeenBeforeStaleStore.getState().remember(id, permissions);
            toast.error(`${shown.manifest.name} changed since you saw it. Check it again.`);
            return;
          }
          toast.error(approve ? 'Couldn’t let it run.' : 'Couldn’t stop it running.', {
            description: err.message,
          });
        },
      }
    );
  }

  function handleToggle(id: string, enabled: boolean) {
    const mutation = enabled ? enableMutation : disableMutation;

    mutation.mutate(id, {
      // The server broadcasts `extension_reloaded`, so the change applies live.
      // No success toast: the switch already reads on/off. The refusal rides in
      // `description`, never concatenated into the headline, because the
      // server's own sentence says what DorkOS did not do and who can (DOR-1507).
      onError: (err) => {
        toast.error(enabled ? 'Couldn’t turn that on.' : 'Couldn’t turn that off.', {
          description: err.message,
        });
      },
    });
  }

  function handleReload() {
    reloadMutation.mutate(undefined, {
      onSuccess: (updated) => {
        toast.success(`Reloaded ${updated.length} extension${updated.length === 1 ? '' : 's'}`);
      },
      onError: (err) => {
        toast.error('Couldn’t reload your extensions.', { description: err.message });
      },
    });
  }

  const sections = useMemo(() => sectionExtensions(extensions), [extensions]);

  if (isLoading) {
    return (
      <div role="status" aria-label="Loading extensions…" className="space-y-1">
        <span className="sr-only">Loading extensions…</span>
        {Array.from({ length: 8 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full rounded-lg motion-reduce:animate-none" />
        ))}
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div role="alert" className="space-y-2 py-8 text-center" data-testid="extensions-load-failed">
        <p className="text-sm font-semibold">Couldn’t load your extensions.</p>
        <p className="text-muted-foreground text-sm">
          They’re still installed, and nothing was turned off.
        </p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => void refetch()}
          disabled={isRefetching}
        >
          Try again
        </Button>
      </div>
    );
  }

  const installed = extensions.filter((ext) => ext.origin === 'user');
  const needYouCount = sections.needsYou.length;
  const offCount = installed.filter(isExtensionOff).length;
  // A pill with nothing behind it is hidden, so its filter falls back to All.
  const shown: ExtensionFilter = offCount === 0 ? 'all' : filter;

  const keep = (ext: ExtensionRecordPublic) =>
    matchesExtensionSearch(ext, query) && (shown === 'all' || isExtensionOff(ext));
  const needsYou = sections.needsYou.filter(keep);
  const everythingElse = sections.everythingElse.filter(keep);
  // DorkOS's own: folded at the end, and only under All.
  const core = shown === 'all' ? sections.core.filter(keep) : [];
  const searching = query.trim().length > 0;
  const nothingMatches = needsYou.length + everythingElse.length + core.length === 0;

  const renderRow = (ext: ExtensionRecordPublic) => (
    <ExtensionRow
      key={ext.id}
      extension={ext}
      pending={approvals.find((approval) => approval.id === ext.id)}
      open={openIds.has(ext.id)}
      onOpenChange={(open) => setOpen(ext.id, open)}
      onToggle={handleToggle}
      isToggling={togglingIds.has(ext.id)}
      onSetRunApproval={handleSetRunApproval}
      isSettingApproval={approvingIds.has(ext.id)}
      onReload={handleReload}
      isReloading={reloadMutation.isPending}
      stepUpRisk={stepUpRisks?.find((risk) => risk.id === ext.id)}
    />
  );

  if (extensions.length === 0) {
    return (
      <div className="space-y-2 py-8 text-center" data-testid="no-extensions">
        <p className="text-sm font-semibold">No extensions yet</p>
        <p className="text-muted-foreground text-sm">
          Extensions add screens and tools for agents.
        </p>
        <Button size="sm" variant="secondary" onClick={() => void openLink('/marketplace')}>
          Browse Marketplace
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-5" data-extension-list="">
      <p className="text-muted-foreground text-[13px]" data-testid="extensions-count">
        {installed.length} installed
        {needYouCount > 0 && (
          <>
            {' · '}
            <span className="text-foreground font-medium">
              {needYouCount === 1 ? '1 needs you' : `${needYouCount} need you`}
            </span>
          </>
        )}
      </p>

      <div className="flex items-center gap-3 max-sm:flex-col max-sm:items-stretch">
        <div className="relative min-w-0 flex-1">
          <Search
            aria-hidden="true"
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search extensions"
            aria-label="Search extensions"
            className="pl-9"
          />
        </div>
        {installed.length > 0 && (
          <div className="flex gap-2 overflow-x-auto" role="group" aria-label="Show">
            <Chip pressed={shown === 'all'} onClick={() => setFilter('all')}>
              All {installed.length}
            </Chip>
            {offCount > 0 && (
              <Chip pressed={shown === 'off'} onClick={() => setFilter('off')}>
                Off {offCount}
              </Chip>
            )}
          </div>
        )}
      </div>

      {nothingMatches ? (
        <div className="space-y-2 py-6 text-center" data-testid="extensions-no-match">
          <p className="text-sm font-semibold">
            {searching ? `Nothing matches “${query.trim()}”` : 'Nothing is off'}
          </p>
          {searching && (
            <Button size="sm" variant="ghost" onClick={() => setQuery('')}>
              Clear search
            </Button>
          )}
        </div>
      ) : (
        <>
          {needsYou.length > 0 && (
            <section aria-labelledby="extensions-needs-you" data-testid="needs-you-section">
              <h3
                id="extensions-needs-you"
                className="text-muted-foreground mb-1 px-3 text-[11px] font-medium max-sm:text-[13px]"
              >
                Needs you
              </h3>
              <ul className="space-y-0.5">{needsYou.map(renderRow)}</ul>
            </section>
          )}

          {everythingElse.length > 0 && (
            <section
              aria-labelledby="extensions-everything-else"
              data-testid="installed-extensions-section"
            >
              {needsYou.length > 0 && (
                <h3
                  id="extensions-everything-else"
                  className="text-muted-foreground mb-1 px-3 text-[11px] font-medium max-sm:text-[13px]"
                >
                  Everything else
                </h3>
              )}
              <ul className="space-y-0.5">{everythingElse.map(renderRow)}</ul>
            </section>
          )}

          {core.length > 0 && (
            <section data-testid="core-extensions-section">
              <button
                type="button"
                aria-expanded={coreOpen || searching}
                onClick={() => setCoreOpen((open) => !open)}
                disabled={searching}
                className="text-muted-foreground hover:text-foreground focus-ring flex min-h-10 w-full items-center gap-1.5 rounded-lg px-3 text-left text-[13px] max-sm:min-h-11"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    'size-4 shrink-0 transition-transform duration-200 motion-reduce:transition-none',
                    (coreOpen || searching) && 'rotate-90'
                  )}
                />
                Comes with DorkOS · {core.length}
              </button>
              {(coreOpen || searching) && <ul className="space-y-0.5">{core.map(renderRow)}</ul>}
            </section>
          )}
        </>
      )}

      <TrustedSourcesSection />

      <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 px-3 text-xs">
        <p>
          Installed extensions live in <code>~/.dork/extensions/</code> or a project’s{' '}
          <code>.dork/extensions/</code>.
        </p>
        <button
          type="button"
          onClick={handleReload}
          disabled={reloadMutation.isPending}
          className="hover:text-foreground focus-ring rounded-sm underline underline-offset-2 disabled:opacity-50"
          data-testid="reload-extensions-button"
        >
          Reload extensions
        </button>
      </div>
    </div>
  );
}
