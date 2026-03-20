---
slug: pulse-ui-overhaul
number: 47
created: 2026-02-21
status: specified
---

# Pulse UI/UX Overhaul — World-Class Scheduler Experience

## Status

Specified

## Authors

Claude Code — 2026-02-21

## Overview

Redesign the DorkOS Pulse scheduler UI from prototype-grade to world-class. The current implementation uses raw HTML elements, custom modal overlays, and Unicode character icons — none of the app's design system primitives (ResponsiveDialog, Switch, Badge, Motion animations). This spec covers a full client-side overhaul of 3 existing components plus sidebar integration, with feature enablement detection, cron presets, timezone search, toast notifications, and responsive mobile support.

## Background / Problem Statement

The Pulse scheduler was built as a functional prototype (Spec #43). It works, but the UI doesn't match the quality of the rest of DorkOS:

1. **Custom modal** instead of `ResponsiveDialog` — no focus trapping, no Escape-to-close, no mobile Drawer
2. **Hand-rolled toggle switch** instead of the shared `<Switch>` component
3. **Unicode characters** (`&#9679;`, `&#10003;`) for status icons instead of Lucide icons
4. **Raw `<select>`** with 400+ unsearchable timezone options
5. **No cron presets** — users must know cron syntax to create schedules
6. **No feature flag detection** — Pulse button always shows even when disabled on server
7. **No animations** — cards appear/disappear without transitions
8. **No feedback** — mutations are fire-and-forget with no toast or inline confirmation
9. **No mobile treatment** — fixed-width grid breaks on narrow viewports
10. **No delete action** for active schedules — only reject on pending ones

## Goals

- All Pulse UI uses the app's design system primitives (ResponsiveDialog, Switch, Badge, Lucide icons, Motion)
- Client detects Pulse enabled/disabled state and renders appropriate UI for each
- Cron preset pills make schedule creation accessible to non-cron-literate users
- Timezone selection is searchable and auto-detects the user's timezone
- Schedule rows have a three-dot overflow menu with Edit, Delete, and Run Now
- Run history shows Lucide icons, relative timestamps, output summaries, and error details
- Active runs are indicated by an animated dot on the sidebar HeartPulse icon
- Toast notifications provide feedback for background actions (Run triggered, errors)
- Full motion/animation matching the rest of the app (AnimatePresence, spring physics)
- Mobile responsive: Drawer containers, 44px touch targets, stacked layouts

## Non-Goals

- Server-side scheduler logic, cron engine, or persistence changes
- Visual cron builder (preset pills + raw input sufficient for V1)
- Alerting/notification system for run completions (Calm Tech: check history, don't push)
- New REST API endpoints (only minor additions to existing config response)
- Obsidian plugin support for Pulse (DirectTransport already stubs Pulse methods)

## Technical Dependencies

### New Dependencies (client only)

| Package                   | Version  | Purpose                                                      |
| ------------------------- | -------- | ------------------------------------------------------------ |
| `sonner`                  | `^2.0.7` | Toast notifications (already used in `@dorkos/web`)          |
| `@radix-ui/react-tooltip` | `^1.x`   | Tooltip for disabled Pulse icon                              |
| `cmdk`                    | `^1.1.x` | Searchable timezone combobox (already used in `@dorkos/web`) |

### Existing Dependencies (no changes)

| Package                         | Version    | Used For                           |
| ------------------------------- | ---------- | ---------------------------------- |
| `motion`                        | `^12.33.0` | AnimatePresence, spring animations |
| `@radix-ui/react-dialog`        | `^1.1.15`  | ResponsiveDialog foundation        |
| `@radix-ui/react-switch`        | `^1.2.6`   | Toggle switch                      |
| `@radix-ui/react-dropdown-menu` | `^2.1.16`  | Schedule row overflow menu         |
| `@tanstack/react-query`         | `^5.62.0`  | Data fetching hooks                |
| `lucide-react`                  | `latest`   | Icons                              |
| `cronstrue`                     | existing   | Cron expression humanization       |

## Detailed Design

### 1. Server Config Extension (Minor Server Change)

The current `GET /api/config` returns `ServerConfig` which does NOT include scheduler state. Add a `pulse` field:

**File:** `apps/server/src/routes/config.ts`

Add to the GET response object:

```typescript
pulse: {
  enabled: !!schedulerService, // true when Pulse routes are mounted
}
```

**File:** `packages/shared/src/schemas.ts`

Extend `ServerConfigSchema` with:

```typescript
pulse: z.object({
  enabled: z.boolean(),
}).optional(),
```

This is the minimal server change needed. The client reads `config.pulse?.enabled` to determine feature state.

### 2. New Shared UI Components

#### 2a. Tooltip Component

**File:** `apps/client/src/layers/shared/ui/tooltip.tsx`

Add the standard shadcn Tooltip wrapper around `@radix-ui/react-tooltip`:

- `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider`
- Export from `shared/ui/index.ts`
- Mount `<TooltipProvider>` in `App.tsx` (wraps the entire app)

#### 2b. Sonner Toaster

**File:** `apps/client/src/layers/shared/ui/sonner.tsx`

Wrap Sonner's `<Toaster />` with theme-aware styling (match the pattern from `@dorkos/web`):

- Detect theme from `useTheme()` hook
- Style with CSS variables to match the app's color tokens
- Export and mount in `App.tsx`

#### 2c. Command / Combobox

**File:** `apps/client/src/layers/shared/ui/command.tsx`

Add the standard shadcn Command wrapper around `cmdk`:

- `Command`, `CommandInput`, `CommandList`, `CommandEmpty`, `CommandGroup`, `CommandItem`
- Export from `shared/ui/index.ts`

### 3. Feature Enablement Detection

#### 3a. Config Hook

**File:** `apps/client/src/layers/entities/pulse/model/use-pulse-config.ts`

```typescript
export function usePulseEnabled(): { enabled: boolean; isLoading: boolean } {
  const transport = useTransport();
  const { data: config, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 60_000, // Cache for 1 minute
  });
  return {
    enabled: config?.pulse?.enabled ?? false,
    isLoading,
  };
}
```

This reuses the same `['config']` query key as SettingsDialog, so they share the cache.

#### 3b. Gated Data Hooks

Update `useSchedules()` and `useRuns()` to accept an `enabled` parameter:

```typescript
export function useSchedules(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['pulse', 'schedules'],
    queryFn: () => transport.listSchedules(),
    enabled, // Don't fetch when Pulse is disabled
  });
}
```

#### 3c. Sidebar Behavior

In `SessionSidebar.tsx`:

- Fetch `usePulseEnabled()` hook
- When disabled: render HeartPulse icon at `opacity-50`, wrap in `Tooltip` ("Pulse is disabled")
- When enabled: render at full opacity, no tooltip
- Clicking always opens the PulsePanel (ResponsiveDialog)
- PulsePanel internally checks `enabled` and renders either the schedule list or the disabled empty state

#### 3d. Active Run Indicator

**File:** `apps/client/src/layers/entities/pulse/model/use-runs.ts`

Add a new hook:

```typescript
export function useActiveRunCount(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['pulse', 'runs', { status: 'running' }],
    queryFn: async () => {
      const runs = await transport.listRuns({ limit: 10 });
      return runs.filter((r) => r.status === 'running').length;
    },
    enabled,
    refetchInterval: 10_000,
  });
}
```

In `SessionSidebar.tsx`, show a pulsing green dot when `activeRunCount > 0`:

```css
@keyframes pulse-dot {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.5;
  }
}
```

Small `absolute` positioned dot (`size-2`, `bg-green-500`, `-top-0.5 -right-0.5`) on the HeartPulse button container.

### 4. PulsePanel Overhaul

**File:** `apps/client/src/layers/features/pulse/ui/PulsePanel.tsx`

#### Container

Replace the custom modal in `SessionSidebar.tsx` with:

```tsx
<ResponsiveDialog open={pulseOpen} onOpenChange={setPulseOpen}>
  <ResponsiveDialogContent className="max-w-2xl gap-0 p-0">
    <ResponsiveDialogHeader className="border-b px-4 py-3">
      <ResponsiveDialogTitle>Pulse Scheduler</ResponsiveDialogTitle>
    </ResponsiveDialogHeader>
    <PulsePanel />
  </ResponsiveDialogContent>
</ResponsiveDialog>
```

#### Disabled Empty State

When `usePulseEnabled()` returns `enabled: false`:

```tsx
<div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
  <HeartPulse className="text-muted-foreground/50 size-8" />
  <div>
    <p className="font-medium">Pulse is not enabled</p>
    <p className="text-muted-foreground mt-1 text-sm">
      Pulse runs AI agent tasks on a schedule. Start DorkOS with the --pulse flag to enable it.
    </p>
  </div>
  <code className="bg-muted mt-2 rounded-md px-3 py-1.5 font-mono text-sm">dorkos --pulse</code>
</div>
```

#### Enabled Empty State (No Schedules)

When enabled but `schedules.length === 0`:

```tsx
<div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
  <Clock className="text-muted-foreground/30 size-8" />
  <div>
    <p className="font-medium">No schedules yet</p>
    <p className="text-muted-foreground mt-1 text-sm">
      Pulse runs AI agent tasks on a schedule — code reviews, health checks, reports, and more.
    </p>
  </div>
  <button onClick={openCreateDialog} className="...primary button styles...">
    New Schedule
  </button>
</div>
```

#### Schedule List

Each schedule renders as a `ScheduleRow` component (extracted for file size):

```tsx
<div className="space-y-2 p-4">
  <div className="flex items-center justify-between">
    <h3 className="text-muted-foreground text-sm font-medium">Schedules</h3>
    <button onClick={openCreateDialog}>New Schedule</button>
  </div>
  <AnimatePresence initial={false}>
    {schedules.map((schedule) => (
      <motion.div
        key={schedule.id}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -8 }}
        transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
      >
        <ScheduleRow
          schedule={schedule}
          expanded={expandedId === schedule.id}
          onToggleExpand={() => toggleExpand(schedule.id)}
          onEdit={() => openEdit(schedule)}
        />
      </motion.div>
    ))}
  </AnimatePresence>
</div>
```

#### Loading State

Replace "Loading schedules..." with skeleton:

```tsx
<div className="space-y-2 p-4">
  {[1, 2, 3].map((i) => (
    <div key={i} className="rounded-lg border p-3">
      <div className="flex items-center gap-3">
        <div className="bg-muted size-2 animate-pulse rounded-full" />
        <div className="flex-1 space-y-1.5">
          <div className="bg-muted h-4 w-32 animate-pulse rounded" />
          <div className="bg-muted h-3 w-48 animate-pulse rounded" />
        </div>
      </div>
    </div>
  ))}
</div>
```

### 5. ScheduleRow Component

**File:** `apps/client/src/layers/features/pulse/ui/ScheduleRow.tsx`

Each schedule row contains:

```
┌─────────────────────────────────────────────────────────┐
│ ● Schedule Name                    [Switch] [⋮]        │
│   Every day at 9:00 AM · Next: in 2 hours               │
└─────────────────────────────────────────────────────────┘
```

**For `pending_approval` schedules:**

```
┌─────────────────────────────────────────────────────────┐
│ ● Pending Schedule Name      [Approve] [Reject]        │
│   Weekdays at 9:00 AM                                    │
└─────────────────────────────────────────────────────────┘
```

**Components:**

- `StatusDot`: green (active+enabled), yellow (pending_approval), neutral-400 (disabled)
- `Switch` from `shared/ui/switch.tsx`: inline toggle for enabled/disabled
- Three-dot `DropdownMenu`: Edit, Run Now, Delete (with separator before Delete)
- Delete triggers a confirmation `Dialog`
- `nextRun` shown as relative time ("in 2 hours") via a `formatRelativeTime()` utility
- Expand/collapse: clicking the row toggles `RunHistoryPanel` with `AnimatePresence`

**Three-dot menu items:**

```tsx
<DropdownMenu>
  <DropdownMenuTrigger asChild>
    <button aria-label={`Actions for ${schedule.name}`}>
      <MoreHorizontal className="size-(--size-icon-sm)" />
    </button>
  </DropdownMenuTrigger>
  <DropdownMenuContent align="end">
    <DropdownMenuItem onClick={onEdit}>
      <Pencil className="mr-2 size-4" /> Edit
    </DropdownMenuItem>
    <DropdownMenuItem onClick={onRunNow} disabled={!schedule.enabled}>
      <Play className="mr-2 size-4" /> Run Now
    </DropdownMenuItem>
    <DropdownMenuSeparator />
    <DropdownMenuItem onClick={onDelete} className="text-destructive">
      <Trash2 className="mr-2 size-4" /> Delete
    </DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

**Delete confirmation dialog:**

```tsx
<Dialog open={deleteConfirmOpen} onOpenChange={setDeleteConfirmOpen}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Delete schedule</DialogTitle>
      <DialogDescription>
        Delete "{schedule.name}"? This will also remove all run history. This action cannot be
        undone.
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <button onClick={() => setDeleteConfirmOpen(false)}>Cancel</button>
      <button onClick={confirmDelete} className="bg-destructive text-destructive-foreground">
        Delete
      </button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

**Run history expand (AnimatePresence):**

```tsx
<AnimatePresence initial={false}>
  {expanded && (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.3, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="border-t px-3 pt-2 pb-3">
        <RunHistoryPanel scheduleId={schedule.id} />
      </div>
    </motion.div>
  )}
</AnimatePresence>
```

### 6. CreateScheduleDialog Overhaul

**File:** `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`

Replace the custom overlay with `ResponsiveDialog`. Stage the form into progressive disclosure sections.

#### Form Layout

```
┌─────────────────────────────────────────────────┐
│ New Schedule                              [×]   │
├─────────────────────────────────────────────────┤
│                                                  │
│ Name *                                           │
│ ┌───────────────────────────────────────────┐   │
│ │ Daily code review                         │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ Prompt *                                         │
│ ┌───────────────────────────────────────────┐   │
│ │ Review all pending PRs and summarize...   │   │
│ │                                           │   │
│ │                                           │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ Schedule *                                       │
│ ┌─────────────────────────────────────────────┐ │
│ │ [5m] [15m] [1h] [6h] [Daily] [9am]         │ │
│ │ [Weekdays] [Weekly] [Monthly]               │ │
│ └─────────────────────────────────────────────┘ │
│ ┌───────────────────────────────────────────┐   │
│ │ 0 9 * * 1-5                               │   │
│ └───────────────────────────────────────────┘   │
│ At 09:00 AM, Monday through Friday              │
│                                                  │
│ ─────────────────────────────────────────────── │
│                                                  │
│ Working Directory                                │
│ ┌───────────────────────────────┐ [Browse]      │
│ │ ~/projects/myapp              │               │
│ └───────────────────────────────┘               │
│                                                  │
│ Timezone                                         │
│ ┌───────────────────────────────────────────┐   │
│ │ 🔍 America/New_York                       │   │
│ └───────────────────────────────────────────┘   │
│                                                  │
│ ▸ Advanced settings                              │
│   ┌─────────────────────────────────────────┐   │
│   │ Permission Mode: ○ Allow edits ○ Full   │   │
│   │ Max Runtime:     [10] minutes            │   │
│   └─────────────────────────────────────────┘   │
│                                                  │
│                        [Cancel] [Create]         │
└─────────────────────────────────────────────────┘
```

#### CronPresets Component

**File:** `apps/client/src/layers/features/pulse/ui/CronPresets.tsx`

```typescript
const PRESETS = [
  { label: '5m', cron: '*/5 * * * *' },
  { label: '15m', cron: '*/15 * * * *' },
  { label: '1h', cron: '0 * * * *' },
  { label: '6h', cron: '0 */6 * * *' },
  { label: 'Daily', cron: '0 0 * * *' },
  { label: '9am', cron: '0 9 * * *' },
  { label: 'Weekdays', cron: '0 9 * * 1-5' },
  { label: 'Weekly', cron: '0 9 * * 1' },
  { label: 'Monthly', cron: '0 9 1 * *' },
] as const;

interface CronPresetsProps {
  value: string;
  onChange: (cron: string) => void;
}

export function CronPresets({ value, onChange }: CronPresetsProps) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PRESETS.map(preset => (
        <button
          key={preset.cron}
          type="button"
          className={cn(
            'rounded-md border px-2 py-1 text-xs font-medium transition-colors',
            value === preset.cron
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-input hover:bg-accent hover:text-accent-foreground'
          )}
          onClick={() => onChange(preset.cron)}
        >
          {preset.label}
        </button>
      ))}
    </div>
  );
}
```

#### TimezoneCombobox Component

**File:** `apps/client/src/layers/features/pulse/ui/TimezoneCombobox.tsx`

Uses `cmdk` (Command) + Popover pattern:

```typescript
interface TimezoneComboboxProps {
  value: string;
  onChange: (tz: string) => void;
}

export function TimezoneCombobox({ value, onChange }: TimezoneComboboxProps) {
  const [open, setOpen] = useState(false);
  const timezones = useMemo(() => {
    try {
      return Intl.supportedValuesOf('timeZone');
    } catch {
      return [];
    }
  }, []);

  // Group by continent
  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tz of timezones) {
      const [continent] = tz.split('/');
      if (!map.has(continent)) map.set(continent, []);
      map.get(continent)!.push(tz);
    }
    return map;
  }, [timezones]);

  const detectedTz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    []
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className="w-full rounded-md border bg-transparent px-3 py-2 text-sm text-left">
          {value || 'System default'}
          <ChevronsUpDown className="ml-auto size-4 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="p-0 w-[--radix-popover-trigger-width]">
        <Command>
          <CommandInput placeholder="Search timezone..." />
          <CommandList>
            <CommandEmpty>No timezone found.</CommandEmpty>
            <CommandGroup heading="Default">
              <CommandItem onSelect={() => { onChange(''); setOpen(false); }}>
                System default
              </CommandItem>
              <CommandItem onSelect={() => { onChange(detectedTz); setOpen(false); }}>
                {detectedTz} (detected)
              </CommandItem>
            </CommandGroup>
            {[...groups.entries()].map(([continent, tzList]) => (
              <CommandGroup key={continent} heading={continent}>
                {tzList.map(tz => (
                  <CommandItem
                    key={tz}
                    value={tz}
                    onSelect={() => { onChange(tz); setOpen(false); }}
                  >
                    {tz.replace(`${continent}/`, '').replace(/_/g, ' ')}
                    {tz === value && <Check className="ml-auto size-4" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

#### Working Directory Field

Integrate the existing `DirectoryPicker` from `features/session-list/`:

```tsx
<div className="flex gap-2">
  <input
    className="flex-1 rounded-md border bg-transparent px-3 py-2 text-sm font-mono"
    value={cwd}
    onChange={(e) => setCwd(e.target.value)}
    placeholder="~/projects/myapp"
  />
  <button
    type="button"
    onClick={() => setDirPickerOpen(true)}
    className="rounded-md border px-2 py-2 text-sm hover:bg-accent"
  >
    <FolderOpen className="size-4" />
  </button>
</div>
<DirectoryPicker
  open={dirPickerOpen}
  onOpenChange={setDirPickerOpen}
  /* DirectoryPicker sets the dir via the existing session directory mechanism;
     we'll need to capture its selection and set cwd state */
/>
```

Note: DirectoryPicker currently sets the global directory state. For Pulse, we need to capture the selection into the form's `cwd` field instead. This may require a minor enhancement to DirectoryPicker to accept an `onSelect` callback, or we create a simplified directory browser component within Pulse. The simplest approach: keep the text input for manual entry and add the Browse button as a V2 enhancement if DirectoryPicker needs modification.

#### Advanced Settings Section

Collapsed by default:

```tsx
<details className="group">
  <summary className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
    <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
    Advanced settings
  </summary>
  <div className="mt-3 space-y-4 pl-6">
    {/* Permission Mode */}
    <fieldset>
      <legend className="mb-2 text-sm font-medium">Permission Mode</legend>
      <div className="space-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" ... /> Allow file edits
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" ... /> Full autonomy
        </label>
        {permissionMode === 'bypassPermissions' && (
          <p className="text-xs text-yellow-600 dark:text-yellow-400">
            Warning: This allows the agent to execute any tool without approval.
          </p>
        )}
      </div>
    </fieldset>

    {/* Max Runtime */}
    <div>
      <Label className="text-sm font-medium">Max Runtime (minutes)</Label>
      <input type="number" className="w-24 ..." min={1} max={720} />
    </div>
  </div>
</details>
```

### 7. RunHistoryPanel Overhaul

**File:** `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`

#### Status Icons (Lucide)

```tsx
function RunStatusIcon({ status }: { status: PulseRun['status'] }) {
  switch (status) {
    case 'running':
      return <Loader2 className="size-(--size-icon-xs) animate-spin text-blue-500" />;
    case 'completed':
      return <CheckCircle2 className="size-(--size-icon-xs) text-green-500" />;
    case 'failed':
      return <XCircle className="size-(--size-icon-xs) text-red-500" />;
    case 'cancelled':
      return <MinusCircle className="text-muted-foreground size-(--size-icon-xs)" />;
  }
}
```

#### Relative Timestamps

```typescript
function formatRelativeTime(dateString: string): string {
  const date = new Date(dateString);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay < 7) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}
```

#### Desktop Layout

```tsx
<div className="hidden grid-cols-[20px_56px_1fr_64px_20px] items-center gap-2 md:grid ...">
  <RunStatusIcon status={run.status} />
  <span className="truncate text-xs capitalize">{run.trigger}</span>
  <span className="text-xs" title={absoluteTimestamp}>
    {formatRelativeTime(run.startedAt)}
  </span>
  <span className="text-xs">{formatDuration(run.durationMs)}</span>
  <ChevronRight className="text-muted-foreground size-(--size-icon-xs)" />
</div>
```

#### Mobile Layout

```tsx
<div className="flex items-center gap-3 py-2 md:hidden">
  <RunStatusIcon status={run.status} />
  <div className="min-w-0 flex-1">
    <div className="flex items-center justify-between">
      <span className="text-xs capitalize">{run.trigger}</span>
      <span className="text-muted-foreground text-xs">{formatRelativeTime(run.startedAt)}</span>
    </div>
    <span className="text-muted-foreground text-xs">{formatDuration(run.durationMs)}</span>
  </div>
  <ChevronRight className="text-muted-foreground size-(--size-icon-xs)" />
</div>
```

#### Output Summary & Error Display

Below each run row, optionally show:

```tsx
{
  run.outputSummary && (
    <p className="text-muted-foreground mt-0.5 truncate pl-7 text-xs">
      {run.outputSummary.split('\n')[0]}
    </p>
  );
}
{
  run.status === 'failed' && run.error && (
    <p className="text-destructive mt-0.5 truncate pl-7 text-xs">{run.error}</p>
  );
}
```

#### Skeleton Loading

```tsx
{
  isLoading && (
    <div className="space-y-2">
      {[1, 2, 3].map((i) => (
        <div key={i} className="flex items-center gap-3 py-2">
          <div className="bg-muted size-3 animate-pulse rounded-full" />
          <div className="flex-1 space-y-1">
            <div className="bg-muted h-3 w-24 animate-pulse rounded" />
            <div className="bg-muted h-3 w-16 animate-pulse rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
```

### 8. Toast Notifications

**Mount in `App.tsx`:**

```tsx
import { Toaster } from '@/layers/shared/ui/sonner';

// Inside the component, after other providers:
<Toaster />;
```

**Usage in mutation hooks (narrow scope):**

```typescript
// In PulsePanel or ScheduleRow — Run Now
triggerSchedule.mutate(schedule.id, {
  onSuccess: () => toast('Run triggered'),
  onError: (err) => toast.error(`Failed to trigger run: ${err.message}`),
});

// Approve
updateSchedule.mutate(
  { id: schedule.id, status: 'active', enabled: true },
  {
    onSuccess: () => toast('Schedule approved'),
    onError: (err) => toast.error(`Failed to approve: ${err.message}`),
  }
);

// Delete
deleteSchedule.mutate(schedule.id, {
  onError: (err) => toast.error(`Failed to delete: ${err.message}`),
});
```

**Do NOT toast for:** toggle on/off, form create/edit success, cancel run, reject.

### 9. SessionSidebar Changes

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

Remove lines 217-233 (custom modal). Replace with:

```tsx
// Imports
import { usePulseEnabled, useActiveRunCount } from '@/layers/entities/pulse';
import { PulsePanel } from '@/layers/features/pulse';
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/layers/shared/ui';

// Inside component:
const { enabled: pulseEnabled } = usePulseEnabled();
const { data: activeRunCount = 0 } = useActiveRunCount(pulseEnabled);

// Pulse button:
<Tooltip>
  <TooltipTrigger asChild>
    <button
      onClick={() => setPulseOpen(true)}
      className={cn(
        'relative rounded-md p-1 transition-colors duration-150 max-md:p-2',
        pulseEnabled
          ? 'text-muted-foreground/50 hover:text-muted-foreground'
          : 'text-muted-foreground/25 hover:text-muted-foreground/40'
      )}
      aria-label="Pulse scheduler"
    >
      <HeartPulse className="size-(--size-icon-sm)" />
      {activeRunCount > 0 && (
        <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-green-500 animate-[pulse-dot_2s_ease-in-out_infinite]" />
      )}
    </button>
  </TooltipTrigger>
  {!pulseEnabled && (
    <TooltipContent side="top">Pulse is disabled</TooltipContent>
  )}
</Tooltip>

// Dialog (replaces custom modal):
<ResponsiveDialog open={pulseOpen} onOpenChange={setPulseOpen}>
  <ResponsiveDialogContent className="max-w-2xl gap-0 p-0 max-h-[80vh] overflow-hidden">
    <ResponsiveDialogHeader className="border-b px-4 py-3">
      <ResponsiveDialogTitle className="text-sm font-medium">
        Pulse Scheduler
      </ResponsiveDialogTitle>
    </ResponsiveDialogHeader>
    <div className="overflow-y-auto">
      <PulsePanel />
    </div>
  </ResponsiveDialogContent>
</ResponsiveDialog>
```

## User Experience

### User Journey: Creating a Schedule

1. User clicks HeartPulse icon in sidebar
2. PulsePanel opens as Dialog (desktop) or Drawer (mobile)
3. If Pulse disabled → educational empty state with `--pulse` instructions
4. If no schedules → inviting empty state with "New Schedule" CTA
5. User clicks "New Schedule"
6. CreateScheduleDialog opens (nested dialog/drawer)
7. User types a name ("Daily PR review")
8. User writes a prompt ("Review all open PRs in this repo...")
9. User clicks "Weekdays" preset pill → cron fills with `0 9 * * 1-5`, preview shows "At 09:00 AM, Monday through Friday"
10. User optionally sets timezone, working directory, advanced settings
11. User clicks "Create" → dialog closes, schedule appears in list with entrance animation
12. Schedule shows green dot (active), cron description, next run time ("in 2 hours")

### User Journey: Managing Schedules

- **Toggle:** Click the Switch to enable/disable. Immediate visual feedback.
- **Edit:** Three-dot menu → Edit → CreateScheduleDialog opens pre-filled
- **Delete:** Three-dot menu → Delete → Confirmation dialog → Schedule removed with exit animation
- **Run Now:** Three-dot menu → Run Now → Toast "Run triggered" → Run appears in history within 10s
- **Approve/Reject (pending):** Inline buttons on the schedule row

### User Journey: Viewing Run History

1. Click a schedule row → expands with animated transition
2. Run history shows with status icons, relative timestamps, durations
3. Running jobs show spinning Loader2 icon, auto-refresh every 10s
4. Failed runs show error message in red below the row
5. Click any run row → navigates to full session transcript in chat panel
6. Cancel button appears for running jobs

## Testing Strategy

### Unit Tests

All test files in `__tests__/` directories, using Vitest + React Testing Library.

#### Component Tests

**PulsePanel.test.tsx:**

- Renders disabled empty state when `usePulseEnabled` returns false
- Renders schedule list empty state when enabled but no schedules
- Renders skeleton loading state while fetching
- Renders schedule list with correct status indicators
- Opens CreateScheduleDialog on "New Schedule" click
- Expands/collapses run history on schedule row click
- Purpose: Validates all PulsePanel states (disabled, empty, loading, populated) render correctly

**ScheduleRow.test.tsx:**

- Renders active schedule with Switch toggle and three-dot menu
- Renders pending_approval schedule with Approve/Reject buttons
- Toggle calls useUpdateSchedule with correct payload
- Dropdown menu opens with Edit, Run Now, Delete items
- Delete triggers confirmation dialog
- Confirm delete calls useDeleteSchedule
- Run Now calls useTriggerSchedule and shows toast
- Purpose: Validates all schedule row interactions and state-dependent rendering

**CreateScheduleDialog.test.tsx:**

- Renders with correct title for create vs edit mode
- Pre-fills form fields in edit mode
- Cron preset click fills cron input and updates preview
- Custom cron input clears preset selection
- Timezone combobox filters and selects timezones
- Advanced section collapsed by default, expandable
- Submit disabled when required fields empty
- Submit calls correct mutation (create vs update)
- Purpose: Validates form behavior, progressive disclosure, and preset interaction

**RunHistoryPanel.test.tsx:**

- Renders skeleton while loading
- Renders empty state when no runs
- Renders Lucide status icons for each run status
- Shows relative timestamps with absolute tooltip
- Shows output summary for completed runs
- Shows error message for failed runs
- Click navigates to session via setActiveSession
- Cancel button appears only for running status
- Purpose: Validates run display, responsive layout, and navigation

#### Hook Tests

**use-pulse-config.test.tsx:**

- Returns enabled: true when config.pulse.enabled is true
- Returns enabled: false when config.pulse is undefined
- Shares cache with ['config'] query key
- Purpose: Validates feature detection logic

**use-schedules.test.tsx (updated):**

- Skips fetch when enabled=false
- Fetches when enabled=true
- Purpose: Validates gated query behavior

**use-runs.test.tsx (updated):**

- useActiveRunCount returns count of running runs
- useActiveRunCount skips polling when enabled=false
- Purpose: Validates active run counting and polling gate

### Mocking Strategies

- Mock `Transport` via `createMockTransport()` from `@dorkos/test-utils`
- Mock `useIsMobile()` for responsive layout tests
- Mock `motion/react` to render plain elements (existing pattern)
- Mock `cronstrue` to avoid parsing complexity in tests
- Mock `sonner` toast function to verify toast calls
- Mock `Intl.supportedValuesOf` and `Intl.DateTimeFormat` for timezone tests

## Performance Considerations

- **Config caching:** `staleTime: 60_000` means config is fetched at most once per minute
- **Run polling:** 10-second interval for active run count — same as existing RunHistoryPanel
- **Timezone list:** Computed once via `useMemo`, ~400 items — negligible
- **AnimatePresence:** GPU-accelerated transforms only (opacity, translateY) — no layout thrashing
- **Sonner:** Lightweight (~3KB gzip), renders portal — no impact on main render tree
- **cmdk:** ~4KB gzip, renders on-demand in popover — lazy loaded

## Security Considerations

- No new API endpoints — existing server-side validation and boundary enforcement apply
- Directory field validated server-side via `isWithinBoundary()` (existing)
- No credential handling or sensitive data display
- Toast content is always controlled (no user input rendered as HTML)

## Documentation

- Update `contributing/design-system.md` to document the Tooltip and Toaster additions
- Update the Pulse section in `CLAUDE.md` to reflect new component structure
- No external user-facing documentation changes needed (Pulse docs already exist)

## Implementation Phases

### Phase 1: Foundation + Feature Detection

- Add `sonner`, `@radix-ui/react-tooltip`, `cmdk` dependencies
- Create shared UI components: Tooltip, Sonner Toaster, Command
- Mount `TooltipProvider` and `Toaster` in App.tsx
- Add `pulse.enabled` to server config response
- Create `usePulseEnabled()` hook
- Update `useSchedules()` and `useRuns()` with `enabled` gate
- Replace custom modal in SessionSidebar with ResponsiveDialog
- Implement disabled empty state in PulsePanel

### Phase 2: Schedule List + Row Overhaul

- Extract `ScheduleRow` component from PulsePanel
- Replace custom toggle with `<Switch>`
- Add three-dot `DropdownMenu` with Edit, Run Now, Delete
- Add delete confirmation dialog
- Add enabled empty state (three-part NN/Group pattern)
- Add skeleton loading state
- Add AnimatePresence for list item entrance/exit

### Phase 3: CreateScheduleDialog Overhaul

- Rewrite with ResponsiveDialog container
- Add `CronPresets` component
- Add `TimezoneCombobox` component
- Implement progressive disclosure (Essential → Common → Advanced)
- Add working directory text input (DirectoryPicker browse as V2)

### Phase 4: Run History + Polish

- Rewrite RunHistoryPanel with Lucide icons
- Add relative timestamps with absolute tooltip
- Add responsive mobile layout (stacked cards)
- Add output summary and error display
- Add skeleton loading state
- Add ChevronRight click affordance
- Add active run indicator dot to sidebar
- Add `useActiveRunCount()` hook
- Wire up toast notifications for Run Now, Approve, and errors
- Update all test files

## Open Questions

1. **DirectoryPicker reuse:** The existing DirectoryPicker sets global directory state. For the Pulse create form, we need it to set a local form field. This may require either (a) adding an `onSelect` callback prop, or (b) building a simplified directory browser within Pulse. Recommendation: start with text input only, add browse button as a fast-follow.

## Related ADRs

- No existing ADRs directly related to Pulse UI. This spec may generate draft ADRs for:
  - Adopting sonner as the app-wide toast library
  - Adopting cmdk for searchable select/combobox patterns

## References

- Spec #43: DorkOS Pulse (Scheduler) — original implementation spec
- Spec #46: Pulse Implementation Completion Gaps — bug fixes and test coverage
- Research: `research/20260221_pulse_scheduler_ux_redesign.md` — 14 sources analyzed
- Smashing Magazine: "Hidden vs. Disabled In UX" (2024) — feature enablement pattern
- NN/Group: "Designing Empty States in Complex Applications" — three-part formula
- Vercel Docs: "Managing Cron Jobs" — cron preset patterns
- Crontab.guru: canonical preset expressions
