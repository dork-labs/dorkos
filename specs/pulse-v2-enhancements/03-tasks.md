---
slug: pulse-v2-enhancements
spec: 02-specification.md
created: 2026-02-21
---

# Pulse V2 Enhancements — Task Breakdown

## Phase 1: Foundation

### Task 1: [P1] Move DirectoryPicker from features to shared/ui layer

**Status:** pending
**Blocked by:** none
**Files:**
- `apps/client/src/layers/features/session-list/ui/DirectoryPicker.tsx` (move from)
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx` (move to)
- `apps/client/src/layers/shared/ui/index.ts` (update barrel)
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx` (update import)

**Description:**

Move `DirectoryPicker.tsx` from `apps/client/src/layers/features/session-list/ui/` to `apps/client/src/layers/shared/ui/`. This is a file move with no content changes in this task.

1. Move the file:
   - From: `apps/client/src/layers/features/session-list/ui/DirectoryPicker.tsx`
   - To: `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`

2. Add export to the shared UI barrel in `apps/client/src/layers/shared/ui/index.ts`:

```typescript
export { DirectoryPicker } from './DirectoryPicker';
```

3. Update the import in `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`:

```typescript
// Before:
import { DirectoryPicker } from './DirectoryPicker';

// After:
import { DirectoryPicker } from '@/layers/shared/ui';
```

Note: The DirectoryPicker can also be added to the existing multi-import from `@/layers/shared/ui` that already exists in SessionSidebar (lines 11-24).

---

### Task 2: [P1] Add onSelect callback prop to DirectoryPicker

**Status:** pending
**Blocked by:** Task 1
**Files:**
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

**Description:**

Add an optional `onSelect` callback prop to DirectoryPicker so it can be reused outside the global session context. When `onSelect` is provided, it fires instead of the global `setSelectedCwd`. When absent, backward-compatible behavior is preserved.

1. Update the `DirectoryPickerProps` interface in `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`:

```typescript
interface DirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (path: string) => void;
}
```

2. Update the component signature to destructure the new prop:

```typescript
export function DirectoryPicker({ open, onOpenChange, onSelect }: DirectoryPickerProps) {
```

3. Update `handleSelect` (browse mode — currently around line 54):

```typescript
const handleSelect = useCallback(() => {
  if (!data?.path) return;
  if (onSelect) {
    onSelect(data.path);
  } else {
    setSelectedCwd(data.path);
  }
  onClose();
}, [data?.path, onSelect, setSelectedCwd, onClose]);
```

4. Update `handleRecentSelect` (recent mode — currently around line 76):

```typescript
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

5. Update `SessionSidebar.tsx` to pass an explicit `onSelect` to preserve existing behavior:

```typescript
<DirectoryPicker
  open={pickerOpen}
  onOpenChange={setPickerOpen}
  onSelect={(path) => {
    setSelectedCwd(path);
  }}
/>
```

The `useDirectoryState()` hook import and `setSelectedCwd` call remain in DirectoryPicker for the `else` branch when `onSelect` is not provided. The `[selectedCwd, setSelectedCwd] = useDirectoryState()` hook call stays unchanged.

---

### Task 3: [P1] Add enablePulseNotifications to Zustand app store

**Status:** pending
**Blocked by:** none
**Files:**
- `apps/client/src/layers/shared/model/app-store.ts`

**Description:**

Add a new persisted boolean setting `enablePulseNotifications` to the Zustand app store. Default is `true` (on by default, user can disable).

1. Add to `BOOL_KEYS` constant (around line 114-131):

```typescript
const BOOL_KEYS = {
  // ... existing keys ...
  enablePulseNotifications: 'dorkos-enable-pulse-notifications',
} as const;
```

2. Add to `BOOL_DEFAULTS` (around line 134-151):

```typescript
const BOOL_DEFAULTS: Record<keyof typeof BOOL_KEYS, boolean> = {
  // ... existing defaults ...
  enablePulseNotifications: true,
};
```

3. Add to `AppState` interface (around line 46-111):

```typescript
enablePulseNotifications: boolean;
setEnablePulseNotifications: (v: boolean) => void;
```

4. Add to the store `create()` body (after the existing boolean settings like `verboseLogging`):

```typescript
enablePulseNotifications: readBool(BOOL_KEYS.enablePulseNotifications, true),
setEnablePulseNotifications: (v) => {
  writeBool(BOOL_KEYS.enablePulseNotifications, v);
  set({ enablePulseNotifications: v });
},
```

The `resetPreferences` function will automatically clear this key because it iterates `Object.values(BOOL_KEYS)`, and `BOOL_DEFAULTS` will reset it to `true`.

---

### Task 4: [P1] Add updateTabBadge utility to favicon-utils

**Status:** pending
**Blocked by:** none
**Files:**
- `apps/client/src/layers/shared/lib/favicon-utils.ts`

**Description:**

Add a `updateTabBadge` utility function to `favicon-utils.ts` that updates the document title with a count prefix for backgrounded tab notifications.

Add at the end of `apps/client/src/layers/shared/lib/favicon-utils.ts`:

```typescript
const DEFAULT_TITLE = 'DorkOS';

/** Update the document title with a badge count prefix for background tab notifications. */
export function updateTabBadge(count: number): void {
  document.title = count > 0 ? `(${count}) ${DEFAULT_TITLE}` : DEFAULT_TITLE;
}
```

Also verify that `updateTabBadge` is re-exported from `apps/client/src/layers/shared/lib/index.ts` (the shared lib barrel). If `favicon-utils` functions are already re-exported there, this will be automatic. If not, add the re-export.

---

## Phase 2: Core Features

### Task 5: [P2] Create CronVisualBuilder component

**Status:** pending
**Blocked by:** none
**Files:**
- `apps/client/src/layers/features/pulse/ui/CronVisualBuilder.tsx` (new file)

**Description:**

Create the `CronVisualBuilder` component with `parseCron`/`assembleCron` utilities and 5 `CronFieldSelect` dropdowns, all in a single file.

Create `apps/client/src/layers/features/pulse/ui/CronVisualBuilder.tsx`:

```typescript
import { useMemo, useCallback } from 'react';
import {
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/layers/shared/ui';

interface CronFields {
  minute: string;
  hour: string;
  dayOfMonth: string;
  month: string;
  dayOfWeek: string;
}

/** @internal Exported for testing only. */
export function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  return {
    minute: parts[0] ?? '*',
    hour: parts[1] ?? '*',
    dayOfMonth: parts[2] ?? '*',
    month: parts[3] ?? '*',
    dayOfWeek: parts[4] ?? '*',
  };
}

/** @internal Exported for testing only. */
export function assembleCron(fields: CronFields): string {
  return `${fields.minute} ${fields.hour} ${fields.dayOfMonth} ${fields.month} ${fields.dayOfWeek}`;
}

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

interface CronVisualBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

/** Visual cron expression builder with 5-field Select dropdowns. */
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
        <SelectTrigger className="h-8 text-xs" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((opt) => {
            const val = typeof opt === 'string' ? opt : opt.value;
            const display = typeof opt === 'string' ? (opt === '*' ? 'Any' : opt) : opt.label;
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

---

### Task 6: [P2] Integrate CronVisualBuilder into CreateScheduleDialog

**Status:** pending
**Blocked by:** Task 5
**Files:**
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`

**Description:**

Add a collapsible "Custom schedule" toggle below CronPresets that expands to show the CronVisualBuilder with AnimatePresence animation.

1. Add imports at the top of `CreateScheduleDialog.tsx`:

```typescript
import { AnimatePresence, motion } from 'motion/react';
import { CronVisualBuilder } from './CronVisualBuilder';
```

Also add `ChevronRight` to the existing lucide-react import if not already there (it IS already imported on line 3).

2. Add state inside the component (after the existing state declarations around line 80):

```typescript
const [customBuilderOpen, setCustomBuilderOpen] = useState(false);
```

3. Replace the schedule section in the render (the `<div className="space-y-2">` block that contains `CronPresets` and the cron input, around lines 160-183). After the `<CronPresets>` line and before the cron `<input>`, insert:

```typescript
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

<input
  id="schedule-cron"
  ... {/* existing cron input unchanged */}
/>
```

The `AnimatePresence` + `motion.div` pattern provides smooth expand/collapse. `initial={false}` prevents animation on first mount. The `CronVisualBuilder` and `CronPresets` share the same `form.cron` state via `onChange`, so two-way sync is automatic: clicking a preset updates builder dropdowns (via `parseCron`), and changing a dropdown updates the raw input and cronstrue preview.

---

### Task 7: [P2] Integrate DirectoryPicker into CreateScheduleDialog

**Status:** pending
**Blocked by:** Task 1, Task 2
**Files:**
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`

**Description:**

Replace the plain text input for the working directory field in CreateScheduleDialog with a display div + FolderOpen button that opens the shared DirectoryPicker.

1. Add imports to `CreateScheduleDialog.tsx`:

```typescript
import { FolderOpen } from 'lucide-react';
import { DirectoryPicker } from '@/layers/shared/ui';
```

2. Add state inside the component:

```typescript
const [cwdPickerOpen, setCwdPickerOpen] = useState(false);
```

3. Replace the working directory section (the `<div className="space-y-1.5">` block containing the `schedule-cwd` input, around lines 188-197) with:

```typescript
<div className="space-y-1.5">
  <Label htmlFor="schedule-cwd">Working Directory</Label>
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
```

4. Add the DirectoryPicker at the bottom of the component, before the closing `</ResponsiveDialog>`:

```typescript
<DirectoryPicker
  open={cwdPickerOpen}
  onOpenChange={setCwdPickerOpen}
  onSelect={(path) => updateField('cwd', path)}
/>
```

---

### Task 8: [P2] Create useCompletedRunBadge hook

**Status:** pending
**Blocked by:** none
**Files:**
- `apps/client/src/layers/entities/pulse/model/use-completed-run-badge.ts` (new file)
- `apps/client/src/layers/entities/pulse/index.ts` (update barrel)

**Description:**

Create a hook that tracks run transitions from `running` to terminal states and exposes an unviewed count with a clear function.

Create `apps/client/src/layers/entities/pulse/model/use-completed-run-badge.ts`:

```typescript
import { useRef, useCallback, useEffect, useState } from 'react';
import { useRuns } from './use-runs';

const STORAGE_KEY = 'dorkos-pulse-last-viewed';

interface CompletedRunBadge {
  unviewedCount: number;
  clearBadge: () => void;
}

/**
 * Track Pulse run completions for badge/notification display.
 *
 * Only fires for runs that transition from `running` to a terminal state
 * during the current session. Runs already complete on initial load are not counted.
 *
 * @param enabled - When false, the hook is disabled (Pulse feature gate).
 */
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

Update the barrel export in `apps/client/src/layers/entities/pulse/index.ts`, adding:

```typescript
export { useCompletedRunBadge } from './model/use-completed-run-badge';
```

Key design decisions:
- Only fires for runs that transition from `running` to terminal during the current session (not retroactive)
- Uses `useRef` for `prevRunningIds` to avoid re-render loops
- `clearBadge()` resets count and persists timestamp to localStorage
- No initial-load spam: `prevRunningIdsRef` starts empty, so runs already complete on load are never counted
- Rides on existing `useRuns()` 10-second poll interval -- no additional network requests

---

### Task 9: [P2] Add amber dot badge and toast notifications to SessionSidebar

**Status:** pending
**Blocked by:** Task 3, Task 8
**Files:**
- `apps/client/src/layers/features/session-list/ui/SessionSidebar.tsx`

**Description:**

Wire up the `useCompletedRunBadge` hook in SessionSidebar to show an amber dot on the HeartPulse button, fire Sonner toasts on completion, and sync badge count to tab title.

1. Add imports to `SessionSidebar.tsx`:

```typescript
import { useCompletedRunBadge } from '@/layers/entities/pulse';
import { toast } from 'sonner';
import { updateTabBadge } from '@/layers/shared/lib';
```

2. Inside the `SessionSidebar` component, after the existing `const { data: activeRunCount = 0 } = useActiveRunCount(pulseEnabled);` line, add:

```typescript
const { unviewedCount, clearBadge } = useCompletedRunBadge(pulseEnabled);
const enablePulseNotifications = useAppStore((s) => s.enablePulseNotifications);
```

3. Add a `useEffect` to clear badge when Pulse panel opens:

```typescript
useEffect(() => {
  if (pulseOpen) clearBadge();
}, [pulseOpen, clearBadge]);
```

4. Add Sonner toast effect. Track previous unviewedCount:

```typescript
const prevUnviewedRef = useRef(0);

useEffect(() => {
  if (!enablePulseNotifications) return;
  if (unviewedCount > prevUnviewedRef.current) {
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

5. Add tab title badge effect:

```typescript
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

6. Update the HeartPulse button JSX (around lines 213-217). Add the amber dot after the existing green dot:

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
- Green pulsing: Run(s) currently active (existing behavior)
- Amber static: Completed run(s) not yet viewed (new)
- When both conditions are true: green takes priority (active run is more urgent)

Also add `useRef` to the imports from 'react' at the top of the file.

---

### Task 10: [P2] Add Pulse notifications toggle to SettingsDialog

**Status:** pending
**Blocked by:** Task 3
**Files:**
- `apps/client/src/layers/features/settings/ui/SettingsDialog.tsx`

**Description:**

Add a "Pulse run notifications" toggle in the Preferences tab of SettingsDialog, near the existing "Notification sound" toggle.

1. In `SettingsDialog.tsx`, add to the destructured `useAppStore()` call (around line 34-72):

```typescript
const {
  // ... existing destructured values ...
  enablePulseNotifications,
  setEnablePulseNotifications,
} = useAppStore();
```

2. Add a new `SettingRow` in the Preferences `TabsContent` (after the "Notification sound" SettingRow, around line 226):

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

---

## Phase 3: Integration & Polish

### Task 11: [P3] Create CronVisualBuilder tests

**Status:** pending
**Blocked by:** Task 5
**Files:**
- `apps/client/src/layers/features/pulse/__tests__/CronVisualBuilder.test.tsx` (new file)

**Description:**

Create unit tests for the CronVisualBuilder component, including `parseCron` and `assembleCron` utility functions.

Create `apps/client/src/layers/features/pulse/__tests__/CronVisualBuilder.test.tsx`:

```typescript
/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { CronVisualBuilder, parseCron, assembleCron } from '../ui/CronVisualBuilder';

describe('parseCron', () => {
  it('parses a standard cron expression into 5 fields', () => {
    const fields = parseCron('0 9 * * 1-5');
    expect(fields).toEqual({
      minute: '0',
      hour: '9',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '1-5',
    });
  });

  it('defaults missing fields to wildcard', () => {
    expect(parseCron('0 9').minute).toBe('0');
    expect(parseCron('0 9').hour).toBe('9');
    expect(parseCron('0 9').dayOfMonth).toBe('*');
    expect(parseCron('0 9').month).toBe('*');
    expect(parseCron('0 9').dayOfWeek).toBe('*');
  });

  it('handles empty string', () => {
    const fields = parseCron('');
    expect(fields).toEqual({
      minute: '*',
      hour: '*',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '*',
    });
  });

  it('handles extra whitespace', () => {
    const fields = parseCron('  0   9   *   *   1-5  ');
    expect(fields).toEqual({
      minute: '0',
      hour: '9',
      dayOfMonth: '*',
      month: '*',
      dayOfWeek: '1-5',
    });
  });
});

describe('assembleCron', () => {
  it('assembles fields into a cron string', () => {
    expect(
      assembleCron({ minute: '0', hour: '9', dayOfMonth: '*', month: '*', dayOfWeek: '1-5' })
    ).toBe('0 9 * * 1-5');
  });

  it('assembles all wildcards', () => {
    expect(
      assembleCron({ minute: '*', hour: '*', dayOfMonth: '*', month: '*', dayOfWeek: '*' })
    ).toBe('* * * * *');
  });
});

describe('CronVisualBuilder', () => {
  it('renders 5 select dropdowns', () => {
    render(<CronVisualBuilder value="* * * * *" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox', { name: /minute/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /hour/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /day/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /month/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /weekday/i })).toBeInTheDocument();
  });

  it('calls onChange when a field is changed', async () => {
    const onChange = vi.fn();
    render(<CronVisualBuilder value="* * * * *" onChange={onChange} />);

    await userEvent.click(screen.getByRole('combobox', { name: /minute/i }));
    await userEvent.click(screen.getByText('30'));

    expect(onChange).toHaveBeenCalledWith('30 * * * *');
  });

  it('updates dropdowns when value prop changes', () => {
    const { rerender } = render(<CronVisualBuilder value="* * * * *" onChange={vi.fn()} />);
    rerender(<CronVisualBuilder value="0 9 * * 1-5" onChange={vi.fn()} />);

    expect(screen.getByRole('combobox', { name: /minute/i })).toHaveTextContent('0');
  });
});
```

---

### Task 12: [P3] Create DirectoryPicker onSelect tests

**Status:** pending
**Blocked by:** Task 1, Task 2
**Files:**
- `apps/client/src/layers/shared/__tests__/DirectoryPicker.test.tsx` (new file)

**Description:**

Create unit tests for the DirectoryPicker `onSelect` callback behavior, validating both the new callback path and backward compatibility.

Create `apps/client/src/layers/shared/__tests__/DirectoryPicker.test.tsx`:

```typescript
/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { DirectoryPicker } from '../ui/DirectoryPicker';

const mockSetSelectedCwd = vi.fn();

vi.mock('@/layers/entities/session', () => ({
  useDirectoryState: () => ['/mock/cwd', mockSetSelectedCwd],
}));

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: vi.fn(() => ({ recentCwds: [] })),
  };
});

const mockTransport = createMockTransport({
  browseDirectory: vi.fn().mockResolvedValue({
    path: '/mocked/path',
    entries: [],
    parent: null,
  }),
});

function Wrapper({ children }: { children: React.ReactNode }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={mockTransport}>
        {children}
      </TransportProvider>
    </QueryClientProvider>
  );
}

describe('DirectoryPicker with onSelect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it('calls setSelectedCwd when onSelect is not provided', async () => {
    render(
      <DirectoryPicker open onOpenChange={vi.fn()} />,
      { wrapper: Wrapper }
    );

    await userEvent.click(screen.getByText('Select'));
    expect(mockSetSelectedCwd).toHaveBeenCalledWith('/mocked/path');
  });
});
```

Note: The exact mock setup may need adjustment based on the existing test infrastructure. The key assertions are:
- When `onSelect` is provided, it fires with the selected path and `setSelectedCwd` is NOT called
- When `onSelect` is absent, `setSelectedCwd` fires (backward compatibility)

---

### Task 13: [P3] Create useCompletedRunBadge tests

**Status:** pending
**Blocked by:** Task 8
**Files:**
- `apps/client/src/layers/entities/pulse/__tests__/use-completed-run-badge.test.ts` (new file)

**Description:**

Create unit tests for the `useCompletedRunBadge` hook, validating transition detection, no initial-load spam, and `clearBadge` behavior.

Create `apps/client/src/layers/entities/pulse/__tests__/use-completed-run-badge.test.ts`:

```typescript
/**
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

let mockRuns: Array<{ id: string; status: string }> = [];

vi.mock('../model/use-runs', () => ({
  useRuns: () => ({ data: mockRuns }),
}));

import { useCompletedRunBadge } from '../model/use-completed-run-badge';

describe('useCompletedRunBadge', () => {
  beforeEach(() => {
    mockRuns = [];
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('returns unviewedCount 0 on initial load', () => {
    const { result } = renderHook(() => useCompletedRunBadge());
    expect(result.current.unviewedCount).toBe(0);
  });

  it('does not count runs that are already completed on first load', () => {
    mockRuns = [
      { id: 'run-1', status: 'completed' },
      { id: 'run-2', status: 'failed' },
    ];
    const { result } = renderHook(() => useCompletedRunBadge());
    expect(result.current.unviewedCount).toBe(0);
  });

  it('increments unviewedCount when a run transitions from running to completed', async () => {
    mockRuns = [{ id: 'run-1', status: 'running' }];
    const { result, rerender } = renderHook(() => useCompletedRunBadge());

    // First render registers run-1 as running
    expect(result.current.unviewedCount).toBe(0);

    // Simulate run completing
    mockRuns = [{ id: 'run-1', status: 'completed' }];
    rerender();

    await waitFor(() => {
      expect(result.current.unviewedCount).toBe(1);
    });
  });

  it('resets unviewedCount to 0 when clearBadge is called', async () => {
    mockRuns = [{ id: 'run-1', status: 'running' }];
    const { result, rerender } = renderHook(() => useCompletedRunBadge());

    mockRuns = [{ id: 'run-1', status: 'completed' }];
    rerender();

    await waitFor(() => {
      expect(result.current.unviewedCount).toBe(1);
    });

    act(() => {
      result.current.clearBadge();
    });

    expect(result.current.unviewedCount).toBe(0);
  });

  it('persists last-viewed timestamp to localStorage', async () => {
    const { result } = renderHook(() => useCompletedRunBadge());

    act(() => {
      result.current.clearBadge();
    });

    const stored = localStorage.getItem('dorkos-pulse-last-viewed');
    expect(stored).toBeTruthy();
    expect(() => new Date(stored!)).not.toThrow();
  });
});
```

---

### Task 14: [P3] Update CreateScheduleDialog tests for visual builder and DirectoryPicker

**Status:** pending
**Blocked by:** Task 6, Task 7
**Files:**
- `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`

**Description:**

Add tests to the existing CreateScheduleDialog test file for the custom builder toggle and DirectoryPicker integration.

Add to the existing test file `apps/client/src/layers/features/pulse/__tests__/CreateScheduleDialog.test.tsx`:

```typescript
// Mock the CronVisualBuilder to avoid Select component complexity
vi.mock('../ui/CronVisualBuilder', () => ({
  CronVisualBuilder: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <div data-testid="cron-visual-builder">
      <span>{value}</span>
      <button onClick={() => onChange('30 * * * *')}>mock-change</button>
    </div>
  ),
}));

// Mock the DirectoryPicker
vi.mock('@/layers/shared/ui/DirectoryPicker', () => ({
  DirectoryPicker: ({ open, onSelect }: { open: boolean; onSelect?: (path: string) => void }) =>
    open ? (
      <div data-testid="directory-picker">
        <button onClick={() => onSelect?.('/selected/path')}>Select</button>
      </div>
    ) : null,
}));

// Mock motion/react to render plain elements
vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}));

it('toggles custom schedule builder on click', async () => {
  render(<CreateScheduleDialog open onOpenChange={vi.fn()} />, { wrapper });
  expect(screen.queryByTestId('cron-visual-builder')).not.toBeInTheDocument();

  await userEvent.click(screen.getByText('Custom schedule'));
  expect(screen.getByTestId('cron-visual-builder')).toBeInTheDocument();
});

it('opens DirectoryPicker and updates cwd field on selection', async () => {
  render(<CreateScheduleDialog open onOpenChange={vi.fn()} />, { wrapper });

  await userEvent.click(screen.getByLabelText('Browse directories'));
  expect(screen.getByTestId('directory-picker')).toBeInTheDocument();

  await userEvent.click(screen.getByText('Select'));
  expect(screen.getByText('/selected/path')).toBeInTheDocument();
});
```

---

### Task 15: [P3] Update SessionSidebar tests for amber badge and notifications

**Status:** pending
**Blocked by:** Task 9
**Files:**
- `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx`

**Description:**

Add tests to the existing SessionSidebar test file for the amber dot badge behavior and notification priority logic.

Add to the existing test file `apps/client/src/layers/features/session-list/__tests__/SessionSidebar.test.tsx`:

```typescript
// Mock useCompletedRunBadge
const mockClearBadge = vi.fn();
let mockUnviewedCount = 0;

vi.mock('@/layers/entities/pulse', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/pulse')>();
  return {
    ...actual,
    useCompletedRunBadge: () => ({
      unviewedCount: mockUnviewedCount,
      clearBadge: mockClearBadge,
    }),
  };
});

// Mock sonner
vi.mock('sonner', () => ({
  toast: vi.fn(),
}));

// Mock updateTabBadge
vi.mock('@/layers/shared/lib', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib')>();
  return {
    ...actual,
    updateTabBadge: vi.fn(),
  };
});

describe('Pulse badge states', () => {
  it('shows amber dot when completed runs are unviewed and no active runs', () => {
    mockUnviewedCount = 2;
    // Mock useActiveRunCount to return 0
    // Render SessionSidebar
    // Expect: element with class bg-amber-500 to be in the document
  });

  it('shows green dot when runs are active, even if unviewed completions exist', () => {
    mockUnviewedCount = 2;
    // Mock useActiveRunCount to return 1
    // Render SessionSidebar
    // Expect: element with class bg-green-500 to be in the document
    // Expect: element with class bg-amber-500 NOT to be in the document
  });

  it('shows no dot when no active runs and no unviewed completions', () => {
    mockUnviewedCount = 0;
    // Mock useActiveRunCount to return 0
    // Render SessionSidebar
    // Expect: neither bg-green-500 nor bg-amber-500 to be in the document
  });
});
```

---

### Task 16: [P3] Update CLAUDE.md documentation

**Status:** pending
**Blocked by:** Task 1, Task 5, Task 8
**Files:**
- `CLAUDE.md`

**Description:**

Update the CLAUDE.md project documentation to reflect the changes made in this spec:

1. Update the **Shared UI** row in the FSD Layers table to include `DirectoryPicker`:

   Change: `14 shadcn primitives (Badge, Dialog, Select, Tabs, etc.)`
   To: `15 shadcn primitives + DirectoryPicker (Badge, Dialog, Select, Tabs, etc.)`

2. Update the **entities/pulse** row in the FSD Layers table to include `useCompletedRunBadge`:

   Change: `useSchedules, useRuns, useCancelRun`
   To: `useSchedules, useRuns, useCancelRun, useCompletedRunBadge`

3. These are minimal updates. The design system documentation in `contributing/design-system.md` should also document the amber badge indicator states, but that can be done as a follow-up if needed.

---

## Dependency Graph

```
Task 1 (Move DirectoryPicker)
  └─> Task 2 (Add onSelect prop)
      └─> Task 7 (DirectoryPicker in CreateScheduleDialog)
          └─> Task 14 (CreateScheduleDialog tests)
      └─> Task 12 (DirectoryPicker tests)

Task 3 (enablePulseNotifications in store)
  └─> Task 9 (Amber badge + toasts in SessionSidebar)
      └─> Task 15 (SessionSidebar tests)
  └─> Task 10 (Settings toggle)

Task 4 (updateTabBadge utility)
  └─> Task 9 (uses updateTabBadge)

Task 5 (CronVisualBuilder component)
  └─> Task 6 (Integrate into CreateScheduleDialog)
      └─> Task 14 (CreateScheduleDialog tests)
  └─> Task 11 (CronVisualBuilder tests)

Task 8 (useCompletedRunBadge hook)
  └─> Task 9 (uses hook in SessionSidebar)
  └─> Task 13 (useCompletedRunBadge tests)

Task 16 (CLAUDE.md docs) - blocked by Tasks 1, 5, 8
```

## Parallel Execution Opportunities

The following tasks have no dependencies on each other and can run in parallel:

**Parallel Group A (Phase 1 - all independent):**
- Task 1 (Move DirectoryPicker)
- Task 3 (enablePulseNotifications store)
- Task 4 (updateTabBadge utility)

**Parallel Group B (Phase 2 - independent of each other):**
- Task 5 (CronVisualBuilder) - no dependencies
- Task 8 (useCompletedRunBadge) - no dependencies

**Parallel Group C (after their respective dependencies):**
- Task 6 (CronVisualBuilder integration) - after Task 5
- Task 7 (DirectoryPicker integration) - after Tasks 1, 2
- Task 10 (Settings toggle) - after Task 3

**Critical Path:**
Task 1 -> Task 2 -> Task 7 -> Task 14
Task 8 -> Task 9 -> Task 15
