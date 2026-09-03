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
import {
  RadioGroup,
  RadioGroupItem,
  Skeleton,
  Badge,
  Input,
  UnverifiedCatalogNotice,
} from '@/layers/shared/ui';
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
 * Whether a line finishes on a model identifier rather than on a sentence.
 *
 * Two kinds of string reach {@link ModelIdLine}. OpenCode builds a description as
 * `` `${providerName} · ${modelId}` `` (`opencode/providers/models.ts`) and the
 * vanished-model banner draws a raw saved id, so both END on the identifier —
 * the case worth protecting. Codex's descriptions are fixed sentences in this
 * repo (`codex/runtime-constants.ts`), and claude-code's arrive from its SDK, so
 * far always as sentences too — every description observed ends either on an id
 * or on prose.
 *
 * The tell is the LAST word: an id carries a path or tag separator inside it,
 * and an English sentence does not end on one. That reads both
 * `google/gemini-3-pro-image` and an Ollama tag
 * (`deepseek-r1:70b-llama-distill-q4_K_M`), which a bare `/` test misses
 * (DOR-1673 review), and it needs no agreement with any server-side template.
 *
 * Only the last word, not the whole string: "Read-only planning mode — the agent
 * cannot execute tools." would otherwise be read as an id the moment someone
 * writes a slash into the middle of a sentence.
 *
 * Three known imprecisions, all cosmetic, none reachable from a producer in this
 * repo today (DOR-1673 review):
 *
 * - A sentence whose last word carries a slash — "Charges separately for
 *   input/output." — is read as an id and ellipsized from the front. Only
 *   claude-code descriptions could ever supply one, and they come from its SDK
 *   rather than from here, so this is not fully ours to prevent. The `<bdi>`
 *   keeps the characters in order either way; the line just loses its opening
 *   words instead of its closing ones.
 * - The last-word test is NARROWER than the whole-string `/` test it replaces.
 *   An id followed by a spaced suffix — `OpenRouter · meta/llama-3.1 (free)` —
 *   ends on `(free)` and so takes the end ellipsis, clipping the id tail. No
 *   producer spaces anything after an id today; if one starts, widen the test
 *   rather than reverting it, or the Ollama case regresses.
 * - A single-segment id with no separator at all (`gpt-oss-120b`) reads as prose
 *   and takes the end ellipsis. That is the honest answer for a string with
 *   nothing marked out as protectable, and such an id is short enough that it
 *   rarely reaches the question.
 *
 * @param text - The whole line about to be drawn.
 */
function endsInIdentifier(text: string): boolean {
  const lastWord = text.slice(text.lastIndexOf(' ') + 1);
  return lastWord.includes('/') || lastWord.includes(':');
}

/**
 * One line whose END is the part worth reading — a model id, or a description
 * that finishes in one — with the ellipsis moved to the START of the line.
 *
 * A plain `truncate` is the wrong tool here, and wrong quietly:
 * `google/gemini-3-pro` and `google/gemini-3-pro-image` are the same string
 * until their last six characters, so clipping the tail throws away the only
 * part that answers "which model is this". What it clips instead is the provider
 * prefix every other row on screen already shares, and which the model NAME on
 * the line above already says.
 *
 * The mechanism is one text node in a right-to-left box: `dir="rtl"` decides
 * only which end of the line the browser's own ellipsis lands on, and the
 * `<bdi dir="ltr">` inside keeps the characters themselves in reading order
 * (see the pairing note below — it is required, not decorative). `text-left` is
 * needed because a right-to-left box would otherwise align a line that fits
 * against the wrong edge.
 *
 * The same treatment ships one feature over, on file paths, for the same reason:
 * `MessageSearchHitRow.tsx` draws a hit's container path with this exact
 * `dir="rtl"` + `<bdi dir="ltr">` pair, because a path's leaf identifies it and
 * its head is what every project repeats. This is that idiom, not a new one.
 *
 * **The two halves are a pair. `dir="rtl"` without a `<bdi dir="ltr">` inside it
 * is a bug, not a shortcut.** `dir="rtl"` sets the paragraph direction, and the
 * bidi algorithm then resolves any character with no strong direction of its own
 * — a space, a dot, a slash, a bracket — against that paragraph rather than
 * against its neighbours. A run of such characters at either END of the string
 * therefore jumps to the other side. Measured in Chromium: without the `<bdi>`,
 * `A model with (parens) at the end.` renders as `.A model with (parens) at the
 * end` — the trailing full stop leading the line. Ids that happen to end on a
 * letter or a digit survive, which is what makes this dangerous: it looks
 * correct on every string you tried and corrupts the first one you did not.
 * The `<bdi>` is `unicode-bidi: isolate`, so the content resolves as its own
 * paragraph and keeps the order it was written in.
 *
 * ONE text node is the point, and the reason this is not the two-span middle
 * ellipsis it replaces (DOR-1673 review). Two boxes side by side are blockified
 * by their flex parent, and blockified boxes break text continuity: measured in
 * Chromium, find-in-page could no longer match the whole id, and copying the
 * line produced `OpenRouter · google/` + a NEWLINE + `gemini-3-pro-image`.
 * Pasting that into a config file or a bug report is worse than a visual clip,
 * and it was a regression against the plain `truncate` this replaced. A single
 * text node with a CSS ellipsis keeps every one of those: the whole id is in the
 * DOM, a screen reader announces it, a selection copies it as one line, and
 * find-in-page matches across it — all verified in a browser, which is the only
 * place any of it is observable.
 *
 * It also costs no measurement (no ref, no `ResizeObserver`, no re-render on
 * resize) and no character budget: how much is dropped answers to the width the
 * row actually got, so it is correct at every popover width, in the mobile
 * sheet, and beside whatever else shares the row.
 *
 * @param props - The text to draw and the classes to draw it in.
 */
function ModelIdLine({ text, className }: { text: string; className?: string }) {
  // `title` on both branches: an ellipsis of either kind eats characters, and
  // pointing at the line is how a person asks for the rest of them.
  if (!endsInIdentifier(text)) {
    // Prose, not an identifier. Its END is the disposable half, so the ordinary
    // end ellipsis is the honest default.
    return (
      <div className={cn('truncate', className)} title={text}>
        {text}
      </div>
    );
  }
  return (
    <div dir="rtl" className={cn('truncate text-left', className)} title={text}>
      <bdi dir="ltr">{text}</bdi>
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
 *
 * Its three text lines each overflow differently, because each one loses a
 * different thing when it is cut (DOR-1673). See the comments inline.
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
        {/* NAME — wraps to a second line instead of truncating. Model names are
            told apart by their suffix as often as their stem (`Preview`,
            `(free)`, `Thinking`), and two lines holds every name a catalog
            ships. Past two it does clip, so a row can never grow without bound,
            and `break-words` keeps an id-shaped name with no spaces in it inside
            the card rather than through its right edge.

            No `title` here, unlike the id line below. Nothing in any catalog we
            have seen reaches a third line, so the attribute would buy a fallback
            for a case that does not happen and cost a native tooltip on every
            hover over a row whose whole job is to be clicked. */}
        <div className="text-foreground line-clamp-2 text-sm font-medium break-words">
          {model.displayName}
          {model.local && (
            <span className="text-muted-foreground ml-1.5 text-3xs font-normal">
              {localDeviceNoun()} · private
            </span>
          )}
        </div>
        {/* ID — ellipsized from the START. This line ends in the raw model id
            (`OpenRouter · google/gemini-3-pro-image`), which is what a person
            reads to tell two near-identical rows apart. */}
        <ModelIdLine
          text={model.description}
          className="text-muted-foreground text-2xs leading-tight"
        />
        {limitation && (
          // WARNING — never truncated, never clamped. It is the one line on the
          // card that exists to change a decision, and half a warning is worse
          // than none. It is a short sentence, so wrapping costs a row at most.
          <div
            className="mt-0.5 text-2xs leading-tight text-amber-600 dark:text-amber-500"
            data-testid={`model-limitation-${model.value}`}
          >
            {limitation}
          </div>
        )}
      </div>

      {model.contextWindow && (
        <Badge variant="secondary" className="shrink-0 text-3xs">
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
        {/* The saved id is ellipsized from the start like a card's: this row
            exists so the person can read WHICH model went away, and the tail is
            the half that says which.

            This is the same component at a bigger type scale (`text-sm`, not
            `text-2xs`) sharing its row with a `shrink-0` sibling, and that
            combination is exactly what broke the treatment this replaced: a tail
            that could not shrink took the row and left the head 8 real pixels at
            390px — too few even to draw an ellipsis, so the line simply began
            mid-word (DOR-1673 review). Nothing here is unshrinkable, so there is
            no per-line budget to get right. */}
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <ModelIdLine text={value} className="text-foreground min-w-0 text-sm font-medium" />
          <span className="text-muted-foreground shrink-0 text-2xs font-normal">
            (not available)
          </span>
        </div>
      </div>
      <p className="text-muted-foreground text-2xs leading-snug">
        This model isn&apos;t available anymore. Pick another.
      </p>
    </div>
  );
}

/** Non-interactive group header rendered between `ModelCard`s inside the shared `RadioGroup`. */
function TierGroupHeader({ slug, label }: { slug: TierGroupSlug; label: string }) {
  return (
    <div
      className="text-muted-foreground mt-2 mb-1 text-2xs font-medium tracking-wide uppercase first:mt-0"
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
