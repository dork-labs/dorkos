---
title: 'Scheduler Dashboard UI Best Practices'
date: 2026-02-22
type: external-best-practices
status: active
tags: [scheduler, dashboard, ui, ux, cron, run-history]
feature_slug: pulse-ui-overhaul
---

# Scheduler Dashboard UI Best Practices

**Date**: 2026-02-22
**Scope**: React + Tailwind + shadcn/ui scheduler/job-runner dashboard
**Depth**: Deep Research

---

## Research Summary

Seven areas of UI/UX best practice were investigated for a scheduler/job-runner dashboard: run history filtering and pagination, timestamp display conventions, skeleton loading, TanStack Query conditional polling, cancel action feedback, trigger type visual distinction, and accessible clickable rows. Each section provides industry examples, a concrete shadcn/ui recommendation, and gotchas.

---

## 1. Run History Filtering and Pagination

### Industry Practice

**Airflow** (Runs tab) provides filter controls for: state (success/failed/running/queued), run type (scheduled/manual/backfill), triggering user, and date range. Filters are surfaced as a persistent toolbar above the list — not hidden in a drawer.

**Dagster** exposes equivalent filtering through its `RunsFilter` API: job name, list of statuses (AND logic), `updatedBefore`, and `createdBefore` datetime bounds.

**Vercel Deployments** uses a minimal filter bar: environment dropdown (production/preview/development) + branch name text input + status badge filter. This is deliberately sparse — most users only need status + environment.

**GitHub Actions** uses tab-based status grouping (All / Queued / In Progress / Completed) plus a search box that accepts `branch:main event:push actor:user` syntax.

### Recommended Approach (shadcn/ui)

```tsx
// Filter bar composition
<div className="flex items-center gap-2 mb-4">
  <Select> {/* Status: All / Running / Success / Failed / Cancelled */}
  <Select> {/* Trigger: All / Scheduled / Manual / Webhook */}
  <DateRangePicker /> {/* shadcn Calendar + Popover */}
  <Button variant="ghost" size="sm" onClick={clearFilters}>Clear</Button>
</div>
```

Keep all filters visible in a single row toolbar (not collapsed). Use query params (`?status=failed&trigger=scheduled`) to make filtered views bookmarkable and shareable.

**Pagination: Cursor over offset for run history.**

Run history is append-only time-series data. Offset pagination produces duplicates and misses when new runs are inserted between pages (a run completing between page 1 and page 2 fetch shifts every offset). Cursor pagination (using the `createdAt` timestamp or run ID as cursor) is consistent regardless of concurrent writes. Performance gap is significant at scale: offset at row 100,000 can be 1,200x slower than cursor on the same dataset.

```
GET /api/runs?limit=25&cursor=<lastRunId>&status=failed
Response: { runs: [...], nextCursor: "<id>", hasMore: true }
```

For a small-scale self-hosted tool (< 10k runs), offset is fine if simpler to implement. Migrate to cursor when you add search/filter combinations.

### Gotchas

- **Don't reset to page 1 on every filter change without debouncing** — fast typists in a search box will fire 5+ requests. Debounce filter input by 300ms.
- **Preserve filter state across navigation** — use nuqs or URLSearchParams, not component state.
- **"Show all" is a footgun** — always cap the result set. Even if the user clears all filters, default to last 7 or 30 days.

---

## 2. Relative vs Absolute Timestamps

### Industry Practice

The widely-adopted hybrid convention (used by GitHub, Slack, Linear, and AWS Cloudscape):

| Time elapsed   | Display                  | Example                |
| -------------- | ------------------------ | ---------------------- |
| 0–59s          | "Just now" or "Xsec ago" | "12s ago"              |
| 1–59m          | Relative minutes         | "14 min ago"           |
| 1–24h          | Relative hours           | "3 hours ago"          |
| 1–6 days       | Relative days            | "2 days ago"           |
| 7+ days        | Absolute short           | "Feb 10, 2:45 PM"      |
| Different year | Absolute with year       | "Jan 5, 2024, 2:45 PM" |

**The canonical threshold is 7 days.** Cloudscape uses this threshold in their design system guidelines. UX research confirms "43 weeks ago" is meaningless — users cannot mentally map it to a calendar date.

**Always pair with tooltip.** Show the opposite format on hover: relative timestamp gets absolute tooltip, absolute gets relative tooltip.

**Facebook / Linear pattern**: Show relative up to "yesterday", then switch to absolute. Linear switches at 6 days.

### Recommended Approach (shadcn/ui)

```tsx
import { formatDistanceToNow, format, differenceInDays } from 'date-fns';

function Timestamp({ date }: { date: Date }) {
  const daysAgo = differenceInDays(new Date(), date);
  const isThisYear = date.getFullYear() === new Date().getFullYear();

  const relative = formatDistanceToNow(date, { addSuffix: true });
  const absolute = isThisYear
    ? format(date, 'MMM d, h:mm a') // "Feb 10, 2:45 PM"
    : format(date, 'MMM d, yyyy, h:mm a'); // "Jan 5, 2024, 2:45 PM"

  const display = daysAgo < 7 ? relative : absolute;
  const title = daysAgo < 7 ? absolute : relative;

  return (
    <time
      dateTime={date.toISOString()}
      title={title}
      className="text-muted-foreground text-sm tabular-nums"
    >
      {display}
    </time>
  );
}
```

Use the `<time>` element with `dateTime` ISO attribute — screen readers and crawlers both benefit.

### Gotchas

- **Never use client-only relative time during SSR** without suppressing hydration mismatch. Either render absolute server-side and hydrate with relative, or use `suppressHydrationWarning` carefully.
- **Don't truncate too aggressively**: "1 min ago" is fine; "1m" is ambiguous (minutes? months?). Use short-form only in very space-constrained cells.
- **Timezone gotcha**: Always store and transmit UTC. Display in the user's local timezone. Add UTC offset in tooltip for operations/debugging contexts.

---

## 3. Skeleton Loading States

### Industry Practice

**Carbon Design System (IBM)**: Skeleton states must match the structural layout of the loaded content exactly — same column widths, same row heights. Use shimmer animation (left-to-right wave) rather than pure pulse.

**GitLab Pajamas**: Skeleton rows should number either the expected data count (if known from a count endpoint) or a sensible default of 5–8 rows for lists. 3 rows for cards/tiles.

**PatternFly**: Parameterizes skeleton row count from the consumer's expected page size. If you paginate at 25, show 10 skeleton rows (enough to communicate structure, not so many that the transition feels jarring).

**Animation**: 1.5s shimmer cycle is the industry consensus for optimal perceived performance. Pure opacity pulse (fade in/out) is a secondary option for reduced-motion contexts.

### Recommended Approach (shadcn/ui)

```tsx
// Use shadcn Skeleton primitive
import { Skeleton } from '@/layers/shared/ui/skeleton';

function RunHistorySkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-md border px-4 py-3">
          <Skeleton className="size-2 rounded-full" /> {/* status dot */}
          <Skeleton className="h-4 w-24" /> {/* run ID */}
          <Skeleton className="ml-auto h-4 w-32" /> {/* timestamp */}
          <Skeleton className="h-4 w-16" /> {/* duration */}
          <Skeleton className="h-5 w-20 rounded-full" /> {/* trigger badge */}
        </div>
      ))}
    </div>
  );
}
```

**Row count rule of thumb**: Match your default page size. If you show 25 rows per page, 8–12 skeleton rows is right (enough structure, not overwhelming). For cards, 3–6.

**Reduced motion**: shadcn's `Skeleton` uses `animate-pulse` (CSS animation). Respect `prefers-reduced-motion` by conditionally removing the animation class:

```tsx
<Skeleton className={cn('h-4 w-24', !reducedMotion && 'animate-pulse')} />
```

Or use `@media (prefers-reduced-motion: reduce)` in your CSS to disable the animation entirely.

### Gotchas

- **Don't show skeleton for cached/stale data** — if TanStack Query has stale data (`data !== undefined`), show stale data immediately and let the background refetch update silently. Skeleton is only for the initial empty state (`isLoading && !data`).
- **Width variation matters**: All skeleton rows with identical widths look unnatural. Vary text placeholder widths (e.g., `w-24`, `w-32`, `w-20`) to approximate real content.
- **Column skeleton must match column structure**: If your table has 5 columns, your skeleton row must have 5 placeholders in the same widths, otherwise the transition from skeleton to data is jarring.

---

## 4. Conditional Polling with TanStack Query

### Industry Practice

TanStack Query v5 changed the `refetchInterval` function signature. The callback now receives the `query` object (not data directly). Data is accessed via `query.state.data`.

### Recommended Pattern (TanStack Query v5)

```ts
// Pattern 1: Function-based refetchInterval (v5 — preferred)
const { data: runs } = useQuery({
  queryKey: ['runs'],
  queryFn: fetchRuns,
  refetchInterval: (query) => {
    const runs = query.state.data;
    const hasActiveRuns = runs?.some((r) => r.status === 'running' || r.status === 'queued');
    return hasActiveRuns ? 3000 : false;
  },
});
```

```ts
// Pattern 2: Derived enabled flag (more readable, v4 and v5 compatible)
const { data: runs } = useQuery({
  queryKey: ['runs'],
  queryFn: fetchRuns,
});

const hasActiveRuns = runs?.some((r) => r.status === 'running' || r.status === 'queued') ?? false;

// Separate polling query or refetchInterval in the same query:
useQuery({
  queryKey: ['runs'],
  queryFn: fetchRuns,
  refetchInterval: hasActiveRuns ? 3000 : false,
  // Note: queryKey must match above so they share the cache
});
```

Pattern 1 is more self-contained. Pattern 2 is more readable when you want to separate concerns (e.g., the active-run check logic lives somewhere else).

**Exponential backoff for error states:**

```ts
refetchInterval: (query) => {
  if (query.state.status === 'error') return false; // stop on error
  const hasActive = query.state.data?.some((r) => r.status === 'running');
  return hasActive ? 3000 : false;
};
```

**Global background refetch config** — disable `refetchOnWindowFocus` for job history (avoid jarring list updates when user tabs back):

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false, // good default for dashboards
      staleTime: 10_000,
    },
  },
});
```

### Gotchas

- **v5 breaking change**: `refetchInterval: (data, query) => ...` is v4 syntax. In v5, it is `(query) => ...` and you read `query.state.data`. Using v4 syntax in v5 silently passes `undefined` as data.
- **`select` transforms are invisible in the callback**: If you use `select: (data) => data.runs`, `query.state.data` inside `refetchInterval` is the **raw** (pre-select) data. Reapply your transform or work with raw data.
- **Don't combine `refetchInterval` with `enabled: false`** — disabled queries never poll regardless of interval.
- **Stale time interaction**: If `staleTime` is longer than `refetchInterval`, the query won't actually refetch. Keep `staleTime` shorter than your polling interval or set `staleTime: 0` for live data.

---

## 5. Cancel Action Feedback

### Industry Practice

**Linear**: Cancel/delete actions use a toast with undo capability (5-second window). No confirmation modal for reversible actions. Confirmation modal only for irreversible destructive actions (deleting a workspace, not a task).

**Vercel**: Cancel deployment uses optimistic UI — the status badge immediately shows "Cancelling..." and the row updates when the server confirms. No modal.

**GitHub Actions**: Cancel workflow run shows a confirmation ("Are you sure?") modal because cancellation is not always undoable (mid-deployment side effects).

**Rule of thumb**:

- Reversible (soft cancel, can be re-triggered): optimistic update + undo toast, no modal
- Irreversible with side effects (kills a process, can't undo): confirmation dialog

### Recommended Approach (shadcn/ui + Sonner)

```tsx
// Optimistic cancel with undo toast (for soft cancels)
import { toast } from 'sonner';

function cancelRun(runId: string) {
  // 1. Optimistically update local cache
  queryClient.setQueryData(['runs'], (old: Run[]) =>
    old.map((r) => (r.id === runId ? { ...r, status: 'cancelling' } : r))
  );

  // 2. Show undo toast with 5s window
  toast('Run cancellation requested', {
    action: {
      label: 'Undo',
      onClick: () => {
        queryClient.invalidateQueries({ queryKey: ['runs'] });
        revertCancel(runId);
      },
    },
    duration: 5000,
  });

  // 3. Fire API call
  cancelRunMutation.mutate(runId, {
    onError: () => {
      // Roll back optimistic update on error
      queryClient.invalidateQueries({ queryKey: ['runs'] });
      toast.error('Failed to cancel run');
    },
  });
}
```

**Button state during cancellation:**

```tsx
<Button
  variant="ghost"
  size="sm"
  disabled={run.status === 'cancelling'}
  onClick={() => cancelRun(run.id)}
>
  {run.status === 'cancelling' ? (
    <>
      <Loader2 className="mr-1 size-3 animate-spin" /> Cancelling
    </>
  ) : (
    'Cancel'
  )}
</Button>
```

**For irreversible hard-cancel (AlertDialog pattern):**

```tsx
<AlertDialog>
  <AlertDialogTrigger asChild>
    <Button variant="destructive" size="sm">
      Cancel Run
    </Button>
  </AlertDialogTrigger>
  <AlertDialogContent>
    <AlertDialogTitle>Cancel this run?</AlertDialogTitle>
    <AlertDialogDescription>
      This will immediately terminate the process. This cannot be undone.
    </AlertDialogDescription>
    <AlertDialogFooter>
      <AlertDialogCancel>Keep Running</AlertDialogCancel>
      <AlertDialogAction onClick={() => cancelRun(run.id)}>Cancel Run</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
```

### Gotchas

- **Don't use a modal for every destructive action** — it trains users to click through confirmation dialogs reflexively, making them useless. Reserve modals for genuinely irreversible actions.
- **Sonner vs shadcn Toast**: shadcn now recommends Sonner (via `npx shadcn add sonner`). Sonner has native promise-based loading/success/error chaining via `toast.promise()`, which is cleaner than manually managing toast IDs.
- **Optimistic update + polling interaction**: If you optimistically set `status: 'cancelling'` and also have a 3s polling interval, the next poll will overwrite your optimistic state with server data. Handle this by either pausing polling during the mutation or using `onSettled` to trigger a targeted invalidation after the mutation completes.

---

## 6. Trigger Type Visual Distinction

### Industry Practice

**GitHub Actions** uses text labels in the workflow run list ("push", "schedule", "workflow_dispatch", "pull_request") with no color distinction — just monochrome text in the trigger column.

**Airflow** (Runs tab) shows run type in a dedicated column with badge-style pills: `scheduled` (blue), `manual` (gray), `backfill` (purple), `dataset_triggered` (green).

**Harness CI** uses icon + label: clock icon for scheduled, play icon for manual, webhook icon for event-based.

**Dagster** uses colored tags for trigger source in the run list.

The icon-only approach fails accessibility — always pair icons with a visible label or at minimum an `aria-label`. Badge > icon-only.

### Recommended Approach (shadcn/ui)

```tsx
import { Clock, Play, Webhook, RefreshCw } from 'lucide-react';
import { Badge } from '@/layers/shared/ui/badge';

const TRIGGER_CONFIG = {
  scheduled: {
    icon: Clock,
    label: 'Scheduled',
    variant: 'secondary' as const,
    className: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950 dark:text-blue-300',
  },
  manual: {
    icon: Play,
    label: 'Manual',
    variant: 'secondary' as const,
    className:
      'bg-neutral-100 text-neutral-700 border-neutral-200 dark:bg-neutral-800 dark:text-neutral-300',
  },
  webhook: {
    icon: Webhook,
    label: 'Webhook',
    variant: 'secondary' as const,
    className:
      'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950 dark:text-purple-300',
  },
  retry: {
    icon: RefreshCw,
    label: 'Retry',
    variant: 'secondary' as const,
    className: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950 dark:text-amber-300',
  },
} as const satisfies Record<
  string,
  { icon: LucideIcon; label: string; variant: 'secondary'; className: string }
>;

function TriggerBadge({ type }: { type: keyof typeof TRIGGER_CONFIG }) {
  const config = TRIGGER_CONFIG[type];
  const Icon = config.icon;
  return (
    <Badge variant={config.variant} className={cn('gap-1', config.className)}>
      <Icon className="size-3" aria-hidden="true" />
      {config.label}
    </Badge>
  );
}
```

Keep the color palette semantic: blue for time-based (clock), neutral for human-initiated (manual), purple for programmatic (webhook). Don't use red — it implies failure.

### Gotchas

- **Don't use color alone to distinguish trigger types** — ensure the label text is always present (WCAG 1.4.1: Use of Color).
- **Icon-only in compact views**: If space is very tight (e.g., a narrow column), show icon-only but add `title` and `aria-label` attributes to the icon wrapper.
- **Consistent enum values**: Decide on your trigger type string union up front. Mixing `"SCHEDULED"` and `"scheduled"` in different parts of the codebase leads to badge rendering failures (`TRIGGER_CONFIG[type]` returns `undefined`). Define the type in `@dorkos/shared/schemas.ts`.

---

## 7. Accessible Clickable Rows

### Industry Practice

Adrian Roselli's canonical article ("Don't Turn a Table into an ARIA Grid Just for a Clickable Row", 2023) is the definitive reference. The recommendation:

**Do not use `role="grid"` or add `onClick` to `<tr>`**. Both approaches break screen reader table traversal. ARIA grid triggers a completely different interaction mode (spreadsheet navigation), which users of screen readers explicitly do not expect on a simple list.

**Three correct approaches** (pick one based on your use case):

1. **Block link inside the cell**: Put an `<a>` inside the primary cell and use CSS `::after` pseudo-element to extend its click target to fill the entire row. This is the most accessible approach — it is real HTML, keyboard-navigable, works with screen readers, and right-click "open in new tab" works.

2. **Row checkbox + label trick**: For selection-based UIs (not navigation), use a `<label>` element inside a checkbox cell with a `::after` pseudo-element spanning the row.

3. **Multiple focusable elements per row**: Put the row's primary action as a `<button>` or `<a>` in the first actionable cell, and additional actions (cancel, view logs) as separate buttons in later cells. This is correct because the entire row is not the interactive element — specific buttons within it are.

### Recommended Approach (shadcn/ui)

**For run history rows where clicking opens a detail view** (navigation):

```tsx
// The "stretched link" pattern — accessible, no ARIA hacks
<tr className="relative hover:bg-muted/50 transition-colors">
  <td className="px-4 py-3">
    {/* Primary link fills the entire row via ::after */}
    <a
      href={`/runs/${run.id}`}
      className={cn(
        "font-medium text-sm",
        // Stretched link: after pseudo-element covers parent <tr>
        "after:absolute after:inset-0 after:content-['']"
      )}
    >
      {run.id}
    </a>
  </td>
  <td className="px-4 py-3 text-muted-foreground">
    <TriggerBadge type={run.trigger} />
  </td>
  <td className="px-4 py-3 relative z-10">
    {/* z-10 lifts action buttons above the stretched link */}
    <Button variant="ghost" size="sm" onClick={...}>Cancel</Button>
  </td>
</tr>
```

The `after:absolute after:inset-0` stretched link covers the entire row. Action buttons in later cells get `relative z-10` to be clickable above the link overlay. This is Bootstrap's "stretched link" pattern, used by GitHub in its PR list.

**For run selection (checkbox-based):**

```tsx
<tr>
  <td>
    <Checkbox
      id={`select-${run.id}`}
      checked={selected}
      onCheckedChange={onSelect}
      aria-label={`Select run ${run.id}`}
    />
  </td>
  {/* other cells */}
</tr>
```

No row-level onClick needed. The checkbox cell handles selection clearly.

### Gotchas

- **Never `onClick` on `<tr>`** — it is not focusable, has no keyboard activation, and is invisible to screen readers. This is the most common anti-pattern in dashboards.
- **Never `role="button"` on `<tr>`** — you must then implement `tabIndex={0}`, `onKeyDown` for Enter/Space, and announce the action to screen readers. That is significant re-implementation of what `<a>` and `<button>` already do for free.
- **`role="grid"` is for spreadsheets** — adding it just to get clickable rows causes screen reader users to enter grid navigation mode (arrow keys move between cells instead of reading text). Don't use it.
- **Test with keyboard-only**: Tab through your row list. Each row's primary action should be reachable and activatable with Enter. Action buttons should be reachable in tab order after the primary link.
- **Focus ring visibility**: Ensure your stretched link's focus ring is visible on the row, not just the text. Use `focus-within:ring-2` on the `<tr>` combined with `focus:outline-none` on the `<a>`:

```tsx
<tr className="focus-within:ring-ring relative focus-within:ring-2 focus-within:ring-offset-1">
  <td>
    <a href="..." className="after:absolute after:inset-0 after:content-[''] focus:outline-none">
      {run.id}
    </a>
  </td>
</tr>
```

---

## Research Gaps and Limitations

- GitHub Actions and Vercel run history filter UI specifics were not available in documentation — findings are based on observation and secondary sources.
- TanStack Query v5 `refetchInterval` function parameter type was confirmed from discussion threads, not the official docs page (which failed to render fully).
- Airflow's specific color values for trigger type badges were not captured — the pattern was confirmed but exact hex values should be verified from the Airflow UI.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "TanStack Query v5 refetchInterval function data parameter", "accessible clickable table row WCAG adrianroselli", "cursor pagination vs offset pagination time series", "cloudscape timestamps pattern"
- Primary information sources: cloudscape.design, adrianroselli.com, tanstack.com, uxmovement.com, airflow.apache.org, github.com/TanStack/query discussions

---

## Sources

- [Absolute vs. Relative Timestamps: When to Use Which - UX Movement](https://uxmovement.com/content/absolute-vs-relative-timestamps-when-to-use-which/)
- [Timestamps - Cloudscape Design System (AWS)](https://cloudscape.design/patterns/general/timestamps/)
- [The Ultimate Guide to Timestamps - Close.com](https://making.close.com/posts/ultimate-guide-to-timestamps/)
- [Don't Turn a Table into an ARIA Grid Just for a Clickable Row - Adrian Roselli](https://adrianroselli.com/2023/11/dont-turn-a-table-into-an-aria-grid-just-for-a-clickable-row.html)
- [Button Pattern - WAI-ARIA APG - W3C](https://www.w3.org/WAI/ARIA/apg/patterns/button/)
- [Data-dependent query refetch interval - TanStack/query Discussion #2086](https://github.com/TanStack/query/discussions/2086)
- [TanStack Query v5 useQuery Reference](https://tanstack.com/query/v5/docs/framework/react/reference/useQuery)
- [Skeleton loading screen design - LogRocket](https://blog.logrocket.com/ux-design/skeleton-loading-screen-design/)
- [Skeleton loader - GitLab Pajamas](https://design.gitlab.com/components/skeleton-loader/)
- [Loading patterns - Carbon Design System](https://carbondesignsystem.com/patterns/loading-pattern/)
- [Offset vs Cursor-Based Pagination - Medium](https://medium.com/@maryam-bit/offset-vs-cursor-based-pagination-choosing-the-best-approach-2e93702a118b)
- [Understanding Cursor Pagination and Why It's So Fast](https://www.milanjovanovic.tech/blog/understanding-cursor-pagination-and-why-its-so-fast-deep-dive)
- [Toast with Action and Cancel - shadcn/ui patterns](https://www.shadcn.io/patterns/sonner-interactive-3)
- [Sonner - shadcn/ui](https://ui.shadcn.com/docs/components/radix/sonner)
- [UI Overview - Apache Airflow](https://airflow.apache.org/docs/apache-airflow/stable/ui.html)
- [Triggers Overview - Harness Developer Hub](https://developer.harness.io/docs/platform/triggers/triggers-overview/)
