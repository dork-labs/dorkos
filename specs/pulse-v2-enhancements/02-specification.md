---
slug: pulse-v2-enhancements
number: 48
created: 2026-02-21
status: specified
---

# Pulse V2 Enhancements — Visual Cron Builder, DirectoryPicker, Calm Notifications

## Status

Specified

## Authors

Claude Code — 2026-02-21

## Overview

Three client-side enhancements deferred from the Pulse UI/UX Overhaul (Spec #47): a visual cron builder with 5-field Select dropdowns, DirectoryPicker integration for the working directory form field, and a three-layer ambient notification system for run completions. All changes are confined to the React client — no server changes, no new npm dependencies.

## Background / Problem Statement

The V1 Pulse UI overhaul delivered design system adoption, cron presets, timezone search, toast infrastructure, and responsive mobile support. Three items were explicitly deferred as V2 enhancements:

1. **Visual cron builder**: Preset pills handle ~80% of scheduling needs, but users who need custom schedules must hand-type cron expressions. A visual builder with dropdowns for each field makes custom schedules accessible without cron literacy.

2. **DirectoryPicker integration**: The working directory field in CreateScheduleDialog is a plain text input. The existing DirectoryPicker component provides a browsable directory tree, but it's coupled to global Zustand state (`setSelectedCwd`). Refactoring it to accept an `onSelect` callback enables reuse in the schedule form.

3. **Run completion notifications**: When a Pulse run completes, there's no ambient signal. Users must manually open the Pulse panel to check. A Calm Tech notification layer — sidebar badge, optional toast, tab title update — provides peripheral awareness without interruption.

## Goals

- Custom cron schedules are accessible via visual dropdowns without requiring cron syntax knowledge
- The visual builder and preset pills stay in sync (two-way binding)
- DirectoryPicker is reusable across features via an optional `onSelect` callback
- The CreateScheduleDialog working directory field uses DirectoryPicker for browsable selection
- Run completions are signaled via an amber sidebar badge (zero interruption)
- Sonner toasts provide opt-in feedback for run completions (on by default, disableable)
- Tab title badge `(N) DorkOS` signals completions when the tab is backgrounded
- All existing tests continue to pass; no regressions in DirectoryPicker or sidebar behavior

## Non-Goals

- Server-side scheduler logic, cron engine, or persistence changes
- Multi-value cron field selectors (e.g., "Monday AND Wednesday") — V3 scope
- Browser Notification API (push notifications) — violates Calm Tech philosophy
- Favicon/PWA badging API (`navigator.setAppBadge`) — limited browser support for non-PWAs
- New REST API endpoints
- New npm dependencies

## Technical Dependencies

### Existing Dependencies (no changes)

| Package | Version | Used For |
|---------|---------|----------|
| `@radix-ui/react-select` | `^2.1.14` | Visual builder field dropdowns |
| `cronstrue` | existing | Cron expression humanization (already imported in CreateScheduleDialog) |
| `sonner` | `^2.0.7` | Toast notifications (already installed and mounted) |
| `motion` | `^12.33.0` | AnimatePresence for builder expand/collapse |
| `lucide-react` | latest | FolderOpen icon for directory picker button |
| `@tanstack/react-query` | `^5.62.0` | Data fetching hooks (useRuns already polls at 10s) |

## Detailed Design

### 1. Visual Cron Builder

#### 1a. `parseCron` and `assembleCron` Utilities

**File:** `apps/client/src/layers/features/pulse/ui/CronVisualBuilder.tsx` (inline)

```typescript
interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  return {
    minute: parts[0] ?? '*',
    hour: parts[1] ?? '*',
    dayOfMonth: parts[2] ?? '*',
    month: parts[3] ?? '*',
    dayOfWeek: parts[4] ?? '*',
  };
}

function assembleCron(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek}`;
}
```

These are pure functions — no validation needed since `cronstrue.toString()` already validates downstream.

#### 1b. Field Definitions

```typescript
const MINUTE_OPTIONS = ['*', '0', '5', '10', '15', '20', '30', '45'] as const;

const HOUR_OPTIONS = ['*', ...Array.from({ length: 24 }, (_, i) => String(i))] as const;

const DAY_OF_MONTH_OPTIONS = ['*', ...Array.from({ length: 31 }, (_, i) => String(i + 1))] as const;

const MONTH_OPTIONS = [
  { value: '*', label: 'Every month' },
  { value: '1', label: 'Jan' }, { value: '2', label: 'Feb' },
  { value: '3', label: 'Mar' }, { value: '4', label: 'Apr' },
  { value: '5', label: 'May' }, { value: '6', label: 'Jun' },
  { value: '7', label: 'Jul' }, { value: '8', label: 'Aug' },
  { value: '9', label: 'Sep' }, { value: '10', label: 'Oct' },
  { value: '11', label: 'Nov' }, { value: '12', label: 'Dec' },
] as const;

const DAY_OF_WEEK_OPTIONS = [
  { value: '*', label: 'Every day' },
  { value: '0', label: 'Sun' }, { value: '1', label: 'Mon' },
  { value: '2', label: 'Tue' }, { value: '3', label: 'Wed' },
  { value: '4', label: 'Thu' }, { value: '5', label: 'Fri' },
  { value: '6', label: 'Sat' },
] as const;
```

#### 1c. CronVisualBuilder Component

**File:** `apps/client/src/layers/features/pulse/ui/CronVisualBuilder.tsx`

```typescript
interface CronVisualBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

export function CronVisualBuilder({ value, onChange }: CronVisualBuilderProps) {
  const fields = useMemo(() => parseCron(value), [value]);

  const updateField = useCallback(
    (field: keyof CronFields, fieldValue: string) => {
      const updated = { ...parseCron(value), [field]: fieldValue };
      onChange(assembleCron(updated));
    },
    [value, onChange]
  );

  return (
    <div className="grid grid-cols-5 gap-2">
      <CronFieldSelect label="Minute" value={fields.minute} options={MINUTE_OPTIONS} onChange={(v) => updateField('minute', v)} />
      <CronFieldSelect label="Hour" value={fields.hour} options={HOUR_OPTIONS} onChange={(v) => updateField('hour', v)} />
      <CronFieldSelect label="Day" value={fields.dayOfMonth} options={DAY_OF_MONTH_OPTIONS} onChange={(v) => updateField('dayOfMonth', v)} />
      <CronFieldSelect label="Month" value={fields.month} options={MONTH_OPTIONS} onChange={(v) => updateField('month', v)} />
      <CronFieldSelect label="Weekday" value={fields.dayOfWeek} options={DAY_OF_WEEK_OPTIONS} onChange={(v) => updateField('dayOfWeek', v)} />
    </div>
  );
}
```

Each `CronFieldSelect` is a thin wrapper around the shadcn `Select` component:

```typescript
function CronFieldSelect({ label, value, options, onChange }: {
  label: string;
  value: string;
  options: readonly string[] | readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[11px] text-muted-foreground">{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => {
            const val = typeof opt === 'string' ? opt : opt.value;
            const display = typeof opt === 'string' ? (opt === '*' ? `Any` : opt) : opt.label;
            return (
              <SelectItem key={val} value={val} className="text-xs">
                {display}
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
    </div>
  );
}
```

#### 1d. Integration in CreateScheduleDialog

**File:** `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`

Add a `customBuilderOpen` state and render the builder below CronPresets:

```typescript
const [customBuilderOpen, setCustomBuilderOpen] = useState(false);

// In render, after CronPresets:
<CronPresets value={form.cron} onChange={(cron) => updateField('cron', cron)} />

<button
  type="button"
  onClick={() => setCustomBuilderOpen((o) => !o)}
  className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
>
  <ChevronRight className={cn(
    'size-3 transition-transform',
    customBuilderOpen && 'rotate-90'
  )} />
  Custom schedule
</button>

<AnimatePresence initial={false}>
  {customBuilderOpen && (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
      className="overflow-hidden"
    >
      <div className="pt-2">
        <CronVisualBuilder
          value={form.cron}
          onChange={(cron) => updateField('cron', cron)}
        />
      </div>
    </motion.div>
  )}
</AnimatePresence>
```

**Preset-builder sync**: Because both `CronPresets` and `CronVisualBuilder` share the same `form.cron` state via `onChange`, clicking a preset updates the builder's dropdowns automatically (via `parseCron`), and changing a dropdown updates the raw input field and cronstrue preview. No additional sync logic needed.

**When the assembled expression matches a preset**: The preset pill highlights via the existing `value === preset.cron` check in CronPresets. When it doesn't match any preset, no pill highlights — correct behavior.

### 2. DirectoryPicker Refactoring

#### 2a. Move to `shared/ui/`

**From:** `apps/client/src/layers/features/session-list/ui/DirectoryPicker.tsx`
**To:** `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`

This is a file move with no content changes beyond the prop addition.

#### 2b. Add `onSelect` Callback Prop

**File:** `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`

Update the interface:

```typescript
interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (path: string) => void;
}
```

Update the two selection handlers:

```typescript
// handleSelect (browse mode) — currently line 54-59
const handleSelect = useCallback(() => {
  if (!data?.path) return;
  if (onSelect) {
    onSelect(data.path);
  } else {
    setSelectedCwd(data.path);
  }
  onClose();
}, [data?.path, onSelect, setSelectedCwd, onClose]);

// handleRecentSelect (recent mode) — currently line 76-82
const handleRecentSelect = useCallback(
  (dirPath: string) => {
    if (onSelect) {
      onSelect(dirPath);
    } else {
      setSelectedCwd(dirPath);
    }
    onClose();
  },
  [onSelect, setSelectedCwd, onClose]
);
```

The `useDirectoryState()` hook import and `setSelectedCwd` call remain — they're used in the `else` branch when `onSelect` is not provided. This preserves backward compatibility.

#### 2c. Update Barrel Exports

**File:** `apps/client/src/layers/shared/ui/index.ts`

Add:
```typescript
export { DirectoryPicker } from './DirectoryPicker';
```

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

Update import:
```typescript
// Before:
import { DirectoryPicker } from './DirectoryPicker';

// After:
import { DirectoryPicker } from '@/layers/shared/ui';
```

SessionSidebar's DirectoryPicker usage changes to pass an explicit `onSelect`:

```typescript
<DirectoryPicker
  open={pickerOpen}
  onOpenChange={setPickerOpen}
  onSelect={(path) => {
    setSelectedCwd(path);
  }}
/>
```

This preserves the existing behavior — `setSelectedCwd` handles both Zustand and URL sync via `useDirectoryState`.

#### 2d. Integration in CreateScheduleDialog

**File:** `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`

Replace the plain text input for the working directory field:

```typescript
const [cwdPickerOpen, setCwdPickerOpen] = useState(false);

// In the "Common settings" section (below timezone):
<div className="space-y-1.5">
  <Label className="text-sm font-medium">Working Directory</Label>
  <div className="flex gap-2">
    <div
      className={cn(
        'flex-1 truncate rounded-md border px-3 py-2 text-sm font-mono',
        form.cwd ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      {form.cwd || 'Default (server working directory)'}
    </div>
    <button
      type="button"
      onClick={() => setCwdPickerOpen(true)}
      className="rounded-md border px-2 py-2 text-sm hover:bg-accent transition-colors"
      aria-label="Browse directories"
    >
      <FolderOpen className="size-4" />
    </button>
  </div>
</div>

<DirectoryPicker
  open={cwdPickerOpen}
  onOpenChange={setCwdPickerOpen}
  onSelect={(path) => updateField('cwd', path)}
/>
```

### 3. Calm Tech Run Completion Notifications

#### 3a. `useCompletedRunBadge` Hook

**File:** `apps/client/src/layers/entities/pulse/model/use-completed-run-badge.ts`

```typescript
import { useRef, useCallback, useEffect } from 'react';
import { useRuns } from './use-runs';

const STORAGE_KEY = 'dorkos-pulse-last-viewed';

interface CompletedRunBadge {
  unviewedCount: number;
  clearBadge: () => void;
}

export function useCompletedRunBadge(enabled = true): CompletedRunBadge {
  const { data: runs } = useRuns({ limit: 50 }, enabled);
  const prevRunningIdsRef = useRef<Set<string>>(new Set());
  const unviewedCountRef = useRef(0);
  const [, forceUpdate] = useState(0);

  // Track which runs were previously "running"
  useEffect(() => {
    if (!runs) return;

    const currentRunning = new Set(
      runs.filter((r) => r.status === 'running').map((r) => r.id)
    );
    const prevRunning = prevRunningIdsRef.current;

    // Detect transitions: was running, now terminal
    let newCompletions = 0;
    for (const id of prevRunning) {
      const run = runs.find((r) => r.id === id);
      if (run && run.status !== 'running') {
        newCompletions++;
      }
    }

    if (newCompletions > 0) {
      unviewedCountRef.current += newCompletions;
      forceUpdate((n) => n + 1);
    }

    prevRunningIdsRef.current = currentRunning;
  }, [runs]);

  const clearBadge = useCallback(() => {
    unviewedCountRef.current = 0;
    localStorage.setItem(STORAGE_KEY, new Date().toISOString());
    forceUpdate((n) => n + 1);
  }, []);

  return {
    unviewedCount: unviewedCountRef.current,
    clearBadge,
  };
}
```

Key design decisions:
- Only fires for runs that transition from `running` → terminal during the current session (not retroactive)
- Uses `useRef` for `prevRunningIds` to avoid re-render loops
- `clearBadge()` resets count and persists timestamp to localStorage
- No initial-load spam: `prevRunningIdsRef` starts empty, so runs already complete on load are never counted

#### 3b. Export from Entity Barrel

**File:** `apps/client/src/layers/entities/pulse/index.ts`

Add:
```typescript
export { useCompletedRunBadge } from './model/use-completed-run-badge';
```

#### 3c. Sidebar Amber Dot Badge

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

Import and use the badge hook:

```typescript
import { useCompletedRunBadge } from '@/layers/entities/pulse';

// Inside component:
const { unviewedCount, clearBadge } = useCompletedRunBadge(pulseEnabled);

// Clear badge when Pulse panel opens:
useEffect(() => {
  if (pulseOpen) clearBadge();
}, [pulseOpen, clearBadge]);
```

Update the HeartPulse button to show the amber dot:

```typescript
<HeartPulse className="size-(--size-icon-sm)" />
{activeRunCount > 0 && (
  <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-green-500 animate-pulse" />
)}
{activeRunCount === 0 && unviewedCount > 0 && (
  <span className="absolute -right-0.5 -top-0.5 size-2 rounded-full bg-amber-500" />
)}
```

Badge states:
- No dot: Pulse disabled or no activity
- Green pulsing: Run(s) currently active
- Amber static: Completed run(s) not yet viewed
- When both conditions are true: green takes priority (active run is more urgent)

#### 3d. Sonner Toast on Run Completion

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

Add a `useRunCompletionToasts` effect that listens to the badge hook and fires toasts:

```typescript
import { toast } from 'sonner';

// Inside component:
const enablePulseNotifications = useAppStore((s) => s.enablePulseNotifications);

// Track previous unviewedCount to detect new completions
const prevUnviewedRef = useRef(0);

useEffect(() => {
  if (!enablePulseNotifications) return;
  if (unviewedCount > prevUnviewedRef.current) {
    // New completion detected
    toast('Pulse run completed', {
      description: 'A scheduled run has finished.',
      duration: 6000,
      action: {
        label: 'View history',
        onClick: () => setPulseOpen(true),
      },
    });
  }
  prevUnviewedRef.current = unviewedCount;
}, [unviewedCount, enablePulseNotifications, setPulseOpen]);
```

#### 3e. `enablePulseNotifications` Setting

**File:** `apps/client/src/layers/shared/model/app-store.ts`

Add to the store:

```typescript
// In BOOL_KEYS:
enablePulseNotifications: 'dorkos-enable-pulse-notifications',

// In AppState interface:
enablePulseNotifications: boolean;
setEnablePulseNotifications: (v: boolean) => void;

// In create():
enablePulseNotifications: readBool(BOOL_KEYS.enablePulseNotifications, true),
setEnablePulseNotifications: (v) => {
  localStorage.setItem(BOOL_KEYS.enablePulseNotifications, String(v));
  set({ enablePulseNotifications: v });
},
```

Default is `true` (on by default, disableable).

#### 3f. Settings Toggle

**File:** `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`

Add a toggle in the existing settings layout, near the notification sound toggle:

```typescript
<SettingRow
  label="Pulse run notifications"
  description="Show a toast when a scheduled Pulse run completes"
>
  <Switch
    checked={enablePulseNotifications}
    onCheckedChange={setEnablePulseNotifications}
  />
</SettingRow>
```

#### 3g. Tab Title Badge

**File:** `apps/client/src/layers/shared/lib/favicon-utils.ts`

Add a utility function:

```typescript
const DEFAULT_TITLE = 'DorkOS';

export function updateTabBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${DEFAULT_TITLE}` : DEFAULT_TITLE;
}
```

**File:** `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

Add a `useEffect` to sync the badge count to the tab title when the tab is hidden:

```typescript
import { updateTabBadge } from '@/layers/shared/lib';

useEffect(() => {
  const handleVisibility = () => {
    if (document.hidden) {
      updateTabBadge(unviewedCount);
    } else {
      updateTabBadge(0);
    }
  };

  // Set immediately if tab is already hidden
  if (document.hidden && unviewedCount > 0) {
    updateTabBadge(unviewedCount);
  }

  document.addEventListener('visibilitychange', handleVisibility);
  return () => {
    document.removeEventListener('visibilitychange', handleVisibility);
    updateTabBadge(0); // Clean up on unmount
  };
}, [unviewedCount]);
```

## User Experience

### User Journey: Creating a Custom Schedule

1. User clicks HeartPulse icon → PulsePanel opens
2. User clicks "New Schedule" → CreateScheduleDialog opens
3. User types a name and prompt
4. For a common schedule: clicks a preset pill (e.g., "Weekdays") — done
5. For a custom schedule: clicks "Custom schedule" toggle below presets
6. 5 Select dropdowns appear with AnimatePresence slide-down
7. User selects Minute=0, Hour=9, Day=*, Month=*, Weekday=1-5
8. Raw cron field updates to `0 9 * * 1-5`, preview shows "At 09:00 AM, Monday through Friday"
9. If user now clicks the "Weekdays" preset pill, the dropdowns update to match
10. User clicks the FolderOpen button next to Working Directory
11. DirectoryPicker opens — user browses to `~/projects/myapp` and clicks Select
12. Working directory field shows the selected path
13. User clicks "Create" → dialog closes, schedule appears in list

### User Journey: Discovering Run Completions

1. User has a "Daily code review" schedule running while they work in another tab
2. Run completes → amber dot appears on HeartPulse button (Layer 1)
3. If tab is backgrounded: title changes to "(1) DorkOS" (Layer 3)
4. If toast enabled: Sonner toast slides in bottom-right "Daily code review completed" with "View history" action (Layer 2, auto-dismisses in 6s)
5. User switches to DorkOS tab → title resets to "DorkOS"
6. User clicks HeartPulse → Pulse panel opens → amber dot clears
7. Run history shows the completed run with green CheckCircle icon

## Testing Strategy

### Unit Tests

#### CronVisualBuilder Tests

**File:** `apps/client/src/layers/features/pulse/__tests__/CronVisualBuilder.test.tsx`

```typescript
/**
 * @vitest-environment jsdom
 */

describe('CronVisualBuilder', () => {
  // Purpose: Validates that parseCron correctly splits cron expressions
  it('parses a standard cron expression into 5 fields', () => {
    const fields = parseCron('0 9 * * 1-5');
    expect(fields).toEqual({
      minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '1-5'
    });
  });

  // Purpose: Validates assembly of fields back to cron string
  it('assembles fields into a cron string', () => {
    expect(assembleCron({ minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '1-5' }))
      .toBe('0 9 * * 1-5');
  });

  // Purpose: Validates that parseCron handles malformed input gracefully
  it('defaults missing fields to wildcard', () => {
    expect(parseCron('0 9').minute).toBe('0');
    expect(parseCron('0 9').dayOfMonth).toBe('*');
  });

  // Purpose: Validates that field changes fire onChange with correct assembled string
  it('calls onChange when a field is changed', async () => {
    const onChange = vi.fn();
    render(<CronVisualBuilder value="* * * * *" onChange={onChange} />);

    // Select minute = 30
    await userEvent.click(screen.getByRole('combobox', { name: /minute/i }));
    await userEvent.click(screen.getByText('30'));

    expect(onChange).toHaveBeenCalledWith('30 * * * *');
  });

  // Purpose: Validates two-way sync — external value changes update dropdowns
  it('updates dropdowns when value prop changes', () => {
    const { rerender } = render(<CronVisualBuilder value="* * * * *" onChange={vi.fn()} />);
    rerender(<CronVisualBuilder value="0 9 * * 1-5" onChange={vi.fn()} />);

    // Verify the minute select shows "0"
    expect(screen.getByRole('combobox', { name: /minute/i })).toHaveTextContent('0');
  });
});
```

#### DirectoryPicker `onSelect` Tests

**File:** `apps/client/src/layers/shared/__tests__/DirectoryPicker.test.tsx`

```typescript
describe('DirectoryPicker with onSelect', () => {
  // Purpose: Validates that onSelect callback fires instead of global state
  it('calls onSelect when provided and user selects a directory', async () => {
    const onSelect = vi.fn();
    render(
      <DirectoryPicker open onOpenChange={vi.fn()} onSelect={onSelect} />,
      { wrapper: Wrapper }
    );

    await userEvent.click(screen.getByText('Select'));
    expect(onSelect).toHaveBeenCalledWith('/mocked/path');
    expect(mockSetSelectedCwd).not.toHaveBeenCalled();
  });

  // Purpose: Validates backward compatibility — global state used when onSelect absent
  it('calls setSelectedCwd when onSelect is not provided', async () => {
    render(
      <DirectoryPicker open onOpenChange={vi.fn()} />,
      { wrapper: Wrapper }
    );

    await userEvent.click(screen.getByText('Select'));
    expect(mockSetSelectedCwd).toHaveBeenCalledWith('/mocked/path');
  });

  // Purpose: Validates recent directory selection also respects onSelect
  it('calls onSelect for recent directory selection', async () => {
    const onSelect = vi.fn();
    // Render with recent dirs in store, switch to recent view, click one
    // Verify onSelect fires with the recent path
  });
});
```

#### `useCompletedRunBadge` Tests

**File:** `apps/client/src/layers/entities/pulse/__tests__/use-completed-run-badge.test.ts`

```typescript
describe('useCompletedRunBadge', () => {
  // Purpose: Validates that initial load does not trigger badge
  it('returns unviewedCount 0 on initial load', () => {
    const { result } = renderHook(() => useCompletedRunBadge(), { wrapper });
    expect(result.current.unviewedCount).toBe(0);
  });

  // Purpose: Validates transition detection from running → completed
  it('increments unviewedCount when a run transitions from running to completed', async () => {
    // First render: run with status 'running'
    // Re-render: same run with status 'completed'
    // Expect unviewedCount to be 1
  });

  // Purpose: Validates that already-complete runs on load don't count
  it('does not count runs that are already completed on first load', () => {
    // Mock transport to return runs already in 'completed' status
    // Expect unviewedCount to remain 0
  });

  // Purpose: Validates clearBadge resets count
  it('resets unviewedCount to 0 when clearBadge is called', () => {
    // After incrementing, call clearBadge
    // Expect unviewedCount to be 0
  });

  // Purpose: Validates localStorage persistence
  it('persists last-viewed timestamp to localStorage', () => {
    // Call clearBadge, check localStorage
  });
});
```

#### CreateScheduleDialog Updates

**File:** `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`

Add tests:

```typescript
// Purpose: Validates that the custom builder toggle expands/collapses
it('toggles custom schedule builder on click', async () => {
  render(<CreateScheduleDialog open onOpenChange={vi.fn()} />, { wrapper });
  expect(screen.queryByLabelText(/minute/i)).not.toBeInTheDocument();

  await userEvent.click(screen.getByText('Custom schedule'));
  expect(screen.getByLabelText(/minute/i)).toBeInTheDocument();
});

// Purpose: Validates DirectoryPicker integration
it('opens DirectoryPicker and updates cwd field on selection', async () => {
  // Click FolderOpen button, verify DirectoryPicker opens
  // Simulate selection, verify form.cwd updates
});
```

#### SessionSidebar Badge Tests

**File:** `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx`

Add tests:

```typescript
// Purpose: Validates amber dot renders when unviewedCount > 0
it('shows amber dot when completed runs are unviewed', () => {
  // Mock useCompletedRunBadge to return { unviewedCount: 2, clearBadge: vi.fn() }
  // Mock useActiveRunCount to return 0
  // Expect amber dot element to be in the document
});

// Purpose: Validates green dot takes priority over amber
it('shows green dot when runs are active, even if unviewed completions exist', () => {
  // Mock both active and completed
  // Expect green dot, not amber
});
```

### Mocking Strategies

- Mock `CronVisualBuilder` in CreateScheduleDialog tests to avoid Select component complexity
- Mock `DirectoryPicker` in CreateScheduleDialog tests (already a separate component)
- Mock `useCompletedRunBadge` in SessionSidebar tests
- Mock `motion/react` to render plain elements (existing pattern in SessionSidebar tests)
- Mock `sonner` toast function to verify toast calls without rendering portal

## Performance Considerations

- **CronVisualBuilder**: `parseCron` runs on every render via `useMemo` — O(1) string split, negligible
- **DirectoryPicker move**: No performance impact — same component, different location
- **Completion badge polling**: Rides on the existing `useRuns()` 10-second poll interval — no additional network requests. O(n) ID comparison per poll where n < 100 (practical schedule count)
- **Tab title updates**: `document.title` writes are synchronous and cheap — no debounce needed
- **localStorage reads**: One read on mount for badge state — negligible

## Security Considerations

- **CronVisualBuilder**: Can only produce well-formed 5-field standard cron strings. The existing `cronstrue.toString()` validation on submit provides belt-and-suspenders protection. No injection risk — values are from controlled Select options.
- **DirectoryPicker `onSelect`**: The path value still originates from the server's `browseDirectory()` response, which is validated by `lib/boundary.ts`. The callback pattern doesn't introduce new attack surface.
- **Toast content**: All toast strings are controlled by application code (schedule names from the server). No user input is rendered as HTML — Sonner escapes content by default.
- **localStorage**: Only stores a timestamp string for "last viewed" — not sensitive data.

## Documentation

- Update `CLAUDE.md` Shared UI table to include DirectoryPicker in `shared/ui/`
- Update `CLAUDE.md` Entities table to include `useCompletedRunBadge` in `entities/pulse/`
- Update `contributing/design-system.md` to document the amber badge indicator states
- No external user-facing documentation changes needed

## Implementation Phases

### Phase 1: DirectoryPicker Refactoring

- Move DirectoryPicker to `shared/ui/`
- Add `onSelect` callback prop
- Update barrel exports
- Update SessionSidebar import and usage
- Integrate into CreateScheduleDialog cwd field
- Update existing tests, add `onSelect` tests

### Phase 2: Visual Cron Builder

- Create `CronVisualBuilder` component with `parseCron`/`assembleCron` utilities
- Add collapsible toggle in CreateScheduleDialog below CronPresets
- Add AnimatePresence expand/collapse animation
- Create CronVisualBuilder tests
- Update CreateScheduleDialog tests

### Phase 3: Calm Tech Notifications

- Create `useCompletedRunBadge` hook
- Add amber dot to SessionSidebar HeartPulse button
- Add `enablePulseNotifications` to Zustand app store
- Add settings toggle in SettingsDialog
- Wire Sonner toast to run completion detection
- Add `updateTabBadge` utility to favicon-utils
- Add tab title sync effect
- Create hook tests and update sidebar tests

## Open Questions

None — all decisions resolved during ideation clarification.

## Related ADRs

- **ADR 0006**: Adopt Sonner for Toast Notifications — toast usage in Pulse follows the narrowly-scoped pattern (background actions only)
- **ADR 0007**: Adopt cmdk for Searchable Combobox — TimezoneCombobox pattern already established; not directly used in this spec but validates the cmdk investment

## References

- Spec #47: Pulse UI/UX Overhaul — parent spec, these were deferred V2 items
- Spec #43: DorkOS Pulse (Scheduler) — original scheduler implementation
- Spec #46: Pulse Implementation Completion Gaps — bug fixes and test coverage
- Research: `research/20260221_pulse_v2_enhancements.md` — library analysis, calm tech research
- Research: `research/20260221_pulse_scheduler_ux_redesign.md` — original UX research
- Calm Technology Principles: calmtech.com
