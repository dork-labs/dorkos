/**
 * The model picker itself — the searchable, grouped list of model cards, and
 * everything it needs to be honest about what it is offering.
 *
 * Split out of `ModelConfigPopover` (which owns the popover shell, effort and
 * mode sections) once that file passed the 500-line "must split" line in
 * `.claude/rules/conventions.md`. The seam is a real one rather than a
 * line-count trick: everything here answers "which model, and what will happen
 * if I pick it?", including the two honesty surfaces added by DOR-1660 — the
 * per-card limitation note and the shortened-catalog notice.
 *
 * @module features/status/ui/ModelSelectionList
 */
import * as React from 'react';
import { AlertCircle, RefreshCw, Search } from 'lucide-react';
import { RadioGroup, RadioGroupItem, Skeleton, Badge, Input } from '@/layers/shared/ui';
import { cn, localDeviceNoun } from '@/layers/shared/lib';
import type { ModelOption } from '@dorkos/shared/types';
import {
  shouldUseTieredMenu,
  matchesQuery,
  groupByTier,
  modelLimitationNote,
  type TierGroupSlug,
} from '../lib/model-menu-tiers';

/** Format a context window token count as a compact badge label (e.g. "200K"). */
function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 1_000_000)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

/** Loading skeleton rendered while models are being fetched. */
export function ModelCardsSkeleton() {
  return (
    <div className="space-y-2" data-testid="model-cards-skeleton">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-xl p-3">
          <Skeleton className="size-4 rounded-full" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-2.5 w-32" />
          </div>
          <Skeleton className="h-5 w-10 rounded-md" />
        </div>
      ))}
    </div>
  );
}

/** Error state with a retry button when model fetching fails. */
export function ModelLoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="flex flex-col items-center gap-3 py-6 text-center"
      data-testid="model-load-error"
    >
      <AlertCircle className="text-muted-foreground size-5" />
      <p className="text-muted-foreground text-xs">Failed to load models</p>
      <button
        onClick={onRetry}
        className="text-foreground hover:bg-accent inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition-colors"
      >
        <RefreshCw className="size-3" />
        Retry
      </button>
    </div>
  );
}

/**
 * Selectable model card with Radix radio indicator and context window badge.
 *
 * When the catalog reports a limit that would surprise the person AFTER they
 * picked the model — it cannot use tools, or it answers with images DorkOS
 * cannot show yet — the card says so on its own line (DOR-1660). The whole point
 * is that the warning arrives before the click.
 */
function ModelCard({ model, isSelected }: { model: ModelOption; isSelected: boolean }) {
  const limitation = modelLimitationNote(model);
  return (
    <label
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 transition-colors duration-150',
        isSelected
          ? 'bg-secondary border-foreground/15'
          : 'border-border hover:border-muted-foreground/30 hover:bg-muted/50 opacity-70'
      )}
    >
      <RadioGroupItem value={model.value} className="shrink-0" />

      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm font-medium">
          {model.displayName}
          {model.local && (
            <span className="text-muted-foreground ml-1.5 text-[10px] font-normal">
              {localDeviceNoun()} · private
            </span>
          )}
        </div>
        <div className="text-muted-foreground truncate text-[11px] leading-tight">
          {model.description}
        </div>
        {limitation && (
          <div
            className="mt-0.5 text-[11px] leading-tight text-amber-600 dark:text-amber-500"
            data-testid={`model-limitation-${model.value}`}
          >
            {limitation}
          </div>
        )}
      </div>

      {model.contextWindow && (
        <Badge variant="secondary" className="shrink-0 text-[10px]">
          {formatContextWindow(model.contextWindow)}
        </Badge>
      )}
    </label>
  );
}

/**
 * A session's saved model that the current options no longer offer (provider
 * switched, model deleted, or a local tag removed). Shown so the person knows
 * their setting is stale and must pick another. The menu never auto-switches.
 */
function UnavailableSavedModel({ value }: { value: string }) {
  return (
    <div className="space-y-1.5" data-testid="model-unavailable-saved">
      <div className="border-border flex w-full items-center gap-3 rounded-xl border border-dashed p-3 opacity-80">
        <AlertCircle className="size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="text-foreground truncate text-sm font-medium">
            {value}
            <span className="text-muted-foreground ml-1.5 text-[11px] font-normal">
              (not available)
            </span>
          </div>
        </div>
      </div>
      <p className="text-muted-foreground text-[11px] leading-snug">
        This model isn&apos;t available anymore. Pick another.
      </p>
    </div>
  );
}

/**
 * Says out loud that the menu is a bounded guess, not the real list.
 *
 * Shown when the runtime found no connected provider: it then offers a
 * shortened slice of every model it has ever heard of, none of which it can
 * confirm you are able to run. Without this the list reads as complete, and the
 * search box turns that into an active falsehood — typing the name of a model
 * that IS in the catalog returns "No models match" because the search only sees
 * the slice. The fix a person actually needs is naming the cause, so the line
 * ends on the action rather than the apology (DOR-1660).
 */
function UnverifiedCatalogNotice() {
  return (
    <p
      className="text-muted-foreground border-border rounded-lg border border-dashed p-2 text-[11px] leading-snug"
      data-testid="model-catalog-unverified"
    >
      This is a short list of models nobody has confirmed you can run. Connect a provider to see the
      ones you actually have.
    </p>
  );
}

/** Non-interactive group header rendered between `ModelCard`s inside the shared `RadioGroup`. */
function TierGroupHeader({ slug, label }: { slug: TierGroupSlug; label: string }) {
  return (
    <div
      className="text-muted-foreground mt-2 mb-1 text-[11px] font-medium tracking-wide uppercase first:mt-0"
      data-testid={`model-group-${slug}`}
    >
      {label}
    </div>
  );
}

interface ModelSelectionListProps {
  models: ModelOption[];
  selectedModel: string;
  onChangeModel: (model: string) => void;
}

/**
 * Model picker: a flat `RadioGroup` of `ModelCard`s for small, untiered
 * catalogs (unchanged claude-code/codex behavior), or a searchable,
 * tier-grouped `RadioGroup` once tiered or past the searchable threshold
 * (`SEARCHABLE_THRESHOLD` in `../lib/model-menu-tiers`) — one `RadioGroup`
 * either way, so keyboard nav spans groups.
 */
export function ModelSelectionList({
  models,
  selectedModel,
  onChangeModel,
}: ModelSelectionListProps) {
  const [query, setQuery] = React.useState('');
  const useSearchableMenu = shouldUseTieredMenu(models);

  // The saved model can stop existing (provider switched, model deleted). Surface
  // it as unavailable and let the person pick another, never auto-switch (spec §11).
  const missingSaved = selectedModel.length > 0 && !models.some((m) => m.value === selectedModel);
  const banner = missingSaved ? <UnavailableSavedModel value={selectedModel} /> : null;

  // A shortened, unconfirmed menu has to admit it. Otherwise the list looks
  // complete when it is a bounded guess, and the search below denies models
  // that really do exist (DOR-1660).
  const isShortened = models.some((m) => m.unverified);

  const filteredModels = React.useMemo(
    () => (useSearchableMenu ? models.filter((m) => matchesQuery(m, query)) : models),
    [models, query, useSearchableMenu]
  );

  const groups = React.useMemo(
    () => (useSearchableMenu ? groupByTier(filteredModels) : []),
    [filteredModels, useSearchableMenu]
  );

  if (!useSearchableMenu) {
    return (
      <div className="space-y-2">
        {banner}
        {isShortened && <UnverifiedCatalogNotice />}
        <RadioGroup
          value={selectedModel}
          onValueChange={onChangeModel}
          className="grid-cols-1 gap-1.5"
          aria-label="Model selection"
          data-testid="model-card-list"
        >
          {models.map((m) => (
            <ModelCard key={m.value} model={m} isSelected={m.value === selectedModel} />
          ))}
        </RadioGroup>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {banner}
      {isShortened && <UnverifiedCatalogNotice />}
      <div className="relative">
        <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2" />
        <Input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search models…"
          aria-label="Search models"
          data-testid="model-search"
          className="h-8 pl-8 text-xs"
        />
      </div>
      {groups.length === 0 ? (
        <p
          className="text-muted-foreground py-4 text-center text-xs"
          data-testid="model-search-empty"
        >
          {isShortened
            ? 'No match in this shortened list. Connect a provider to search everything you can run.'
            : 'No models match'}
        </p>
      ) : (
        <RadioGroup
          value={selectedModel}
          onValueChange={onChangeModel}
          className="grid-cols-1 gap-1.5"
          aria-label="Model selection"
          data-testid="model-card-list"
        >
          {groups.map((group) => (
            <React.Fragment key={group.slug}>
              <TierGroupHeader slug={group.slug} label={group.label} />
              {group.models.map((m) => (
                <ModelCard key={m.value} model={m} isSelected={m.value === selectedModel} />
              ))}
            </React.Fragment>
          ))}
        </RadioGroup>
      )}
    </div>
  );
}
