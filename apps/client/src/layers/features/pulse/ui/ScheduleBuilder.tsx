import { useState, useEffect, useRef } from 'react';
import cronstrue from 'cronstrue';
import { AnimatePresence, motion } from 'motion/react';
import { cn } from '@/layers/shared/lib';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Input,
} from '@/layers/shared/ui';

// ─── Types ───────────────────────────────────────────────────────────

/** Frequency options for the simple schedule builder. */
export type Frequency = '15m' | 'hourly' | 'daily' | 'weekly' | 'monthly';

type ScheduleMode = 'simple' | 'cron';

/** Configuration for the simple schedule mode. */
export interface SimpleConfig {
  frequency: Frequency;
  /** Hour of the day (0-23). */
  hour: number;
  /** Days of the week (0=Sun, 1=Mon, ..., 6=Sat) — used for weekly. */
  days: number[];
  /** Day of the month (1-31) — used for monthly. */
  dayOfMonth: number;
}

interface ScheduleBuilderProps {
  value: string;
  onChange: (cron: string) => void;
}

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULT_CONFIG: SimpleConfig = {
  frequency: 'daily',
  hour: 9,
  days: [1, 2, 3, 4, 5],
  dayOfMonth: 1,
};

/** Default cron expression matching the simple builder's initial config (daily at 9 AM). */
export const DEFAULT_CRON = '0 9 * * *';

const FREQUENCY_OPTIONS: { value: Frequency; label: string }[] = [
  { value: '15m', label: 'Every 15 minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekly', label: 'Every week' },
  { value: 'monthly', label: 'Every month' },
];

const DAY_LABELS: { value: number; label: string }[] = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 0, label: 'Sun' },
];

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAYS = [1, 2, 3, 4, 5];
const WEEKEND = [0, 6];

const ANIMATION_TRANSITION = { duration: 0.2, ease: [0.4, 0, 0.2, 1] as const };

// ─── Helper Functions ────────────────────────────────────────────────

/**
 * Parse a cron expression into a SimpleConfig, or null if not representable.
 *
 * @internal Exported for testing only.
 */
export function parseCronToSimple(cron: string): SimpleConfig | null {
  const trimmed = cron.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return null;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  // Month must be wildcard for simple mode
  if (month !== '*') return null;

  // Every 15 minutes: */15 * * * *
  if (minute === '*/15' && hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return { ...DEFAULT_CONFIG, frequency: '15m' };
  }

  // All other simple patterns require minute=0
  if (minute !== '0') return null;

  // Hourly: 0 * * * *
  if (hour === '*' && dayOfMonth === '*' && dayOfWeek === '*') {
    return { ...DEFAULT_CONFIG, frequency: 'hourly' };
  }

  // Hour must be a single number for remaining patterns
  const h = Number(hour);
  if (!Number.isInteger(h) || h < 0 || h > 23) return null;

  // Monthly: 0 H D * *
  if (dayOfMonth !== '*' && dayOfWeek === '*') {
    const dom = Number(dayOfMonth);
    if (!Number.isInteger(dom) || dom < 1 || dom > 31) return null;
    return { ...DEFAULT_CONFIG, frequency: 'monthly', hour: h, dayOfMonth: dom };
  }

  // Daily: 0 H * * *
  if (dayOfMonth === '*' && dayOfWeek === '*') {
    return { ...DEFAULT_CONFIG, frequency: 'daily', hour: h };
  }

  // Weekly: 0 H * * D,D,... or 0 H * * D-D
  if (dayOfMonth === '*' && dayOfWeek !== '*') {
    const days = parseDayOfWeek(dayOfWeek);
    if (!days) return null;
    return { ...DEFAULT_CONFIG, frequency: 'weekly', hour: h, days };
  }

  return null;
}

/** Parse day-of-week field into sorted array of day numbers, or null if invalid. */
function parseDayOfWeek(field: string): number[] | null {
  const days: number[] = [];

  for (const part of field.split(',')) {
    const rangeMatch = part.match(/^(\d)-(\d)$/);
    if (rangeMatch) {
      const start = Number(rangeMatch[1]);
      const end = Number(rangeMatch[2]);
      if (start > 6 || end > 6 || start > end) return null;
      for (let i = start; i <= end; i++) days.push(i);
    } else {
      const d = Number(part);
      if (!Number.isInteger(d) || d < 0 || d > 6) return null;
      days.push(d);
    }
  }

  return days.length > 0 ? days.sort((a, b) => a - b) : null;
}

/**
 * Build a cron expression from a SimpleConfig.
 *
 * @internal Exported for testing only.
 */
export function buildCron(config: SimpleConfig): string {
  switch (config.frequency) {
    case '15m':
      return '*/15 * * * *';
    case 'hourly':
      return '0 * * * *';
    case 'daily':
      return `0 ${config.hour} * * *`;
    case 'weekly':
      return `0 ${config.hour} * * ${config.days.join(',')}`;
    case 'monthly':
      return `0 ${config.hour} ${config.dayOfMonth} * *`;
  }
}

/**
 * Format a 24-hour number as a 12-hour time string.
 *
 * @internal Exported for testing only.
 */
export function formatHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 || 12;
  return `${h}:00 ${period}`;
}

/** Format an ordinal number (1st, 2nd, 3rd, 4th, ..., 11th, 12th, 21st, etc.) */
function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  const mod10 = n % 10;
  if (mod10 === 1) return `${n}st`;
  if (mod10 === 2) return `${n}nd`;
  if (mod10 === 3) return `${n}rd`;
  return `${n}th`;
}

/** Check if two sorted arrays are equal. */
function arraysEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Generate a human-readable preview of a SimpleConfig.
 *
 * @internal Exported for testing only.
 */
export function getSimplePreview(config: SimpleConfig): string {
  const time = formatHour(config.hour);

  switch (config.frequency) {
    case '15m':
      return 'Runs every 15 minutes';
    case 'hourly':
      return 'Runs every hour, on the hour';
    case 'daily':
      return `Runs every day at ${time}`;
    case 'weekly': {
      const sorted = [...config.days].sort((a, b) => a - b);
      if (arraysEqual(sorted, WEEKDAYS)) return `Runs every weekday at ${time}`;
      if (arraysEqual(sorted, WEEKEND)) {
        return `Runs every Saturday and Sunday at ${time}`;
      }
      // Sort in display order: Mon(1)->Sun(0) — put 0 at the end
      const displayOrder = sorted.filter((d) => d !== 0).concat(sorted.includes(0) ? [0] : []);
      const names = displayOrder.map((d) => DAY_NAMES[d]);
      if (names.length === 1) return `Runs every ${names[0]} at ${time}`;
      if (names.length === 2) return `Runs every ${names[0]} and ${names[1]} at ${time}`;
      const last = names.pop()!;
      return `Runs every ${names.join(', ')}, and ${last} at ${time}`;
    }
    case 'monthly':
      return `Runs on the ${ordinal(config.dayOfMonth)} of every month at ${time}`;
  }
}

/** Get a human-readable preview of a raw cron expression using cronstrue. */
function getCronPreview(cron: string): string {
  if (!cron.trim()) return '';
  try {
    return cronstrue.toString(cron);
  } catch {
    return 'Invalid cron expression';
  }
}

// ─── Component ───────────────────────────────────────────────────────

/** Frequency-based schedule builder with cron escape hatch. */
export function ScheduleBuilder({ value, onChange }: ScheduleBuilderProps) {
  const parsed = parseCronToSimple(value);
  const [mode, setMode] = useState<ScheduleMode>(parsed ? 'simple' : (value.trim() ? 'cron' : 'simple'));
  const [config, setConfig] = useState<SimpleConfig>(parsed ?? DEFAULT_CONFIG);
  const prevValueRef = useRef(value);

  // Sync from external value changes (e.g., edit mode)
  useEffect(() => {
    if (value === prevValueRef.current) return;
    prevValueRef.current = value;
    const newParsed = parseCronToSimple(value);
    if (newParsed) {
      setMode('simple');
      setConfig(newParsed);
    } else if (value.trim()) {
      setMode('cron');
    }
  }, [value]);

  function emitChange(newConfig: SimpleConfig) {
    setConfig(newConfig);
    const cron = buildCron(newConfig);
    prevValueRef.current = cron;
    onChange(cron);
  }

  function handleFrequencyChange(frequency: Frequency) {
    emitChange({ ...config, frequency });
  }

  function handleHourChange(hourStr: string) {
    emitChange({ ...config, hour: Number(hourStr) });
  }

  function handleDayToggle(day: number) {
    const isActive = config.days.includes(day);
    // Prevent deselecting last day
    if (isActive && config.days.length <= 1) return;
    const newDays = isActive
      ? config.days.filter((d) => d !== day)
      : [...config.days, day].sort((a, b) => a - b);
    emitChange({ ...config, days: newDays });
  }

  function handleDayOfMonthChange(domStr: string) {
    emitChange({ ...config, dayOfMonth: Number(domStr) });
  }

  function switchToCron() {
    setMode('cron');
  }

  function switchToSimple() {
    setMode('simple');
    const newCron = buildCron(config);
    prevValueRef.current = newCron;
    onChange(newCron);
  }

  const needsTime = config.frequency !== '15m' && config.frequency !== 'hourly';

  if (mode === 'cron') {
    return (
      <div className="space-y-2">
        <button
          type="button"
          onClick={switchToSimple}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
        >
          Back to simple schedule
        </button>
        <Input
          className="font-mono"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0 9 * * 1-5"
        />
        {value.trim() && (
          <p className={cn(
            'text-xs',
            getCronPreview(value) === 'Invalid cron expression'
              ? 'text-destructive'
              : 'text-muted-foreground'
          )}>
            {getCronPreview(value)}
          </p>
        )}
        <a
          href="https://crontab.guru"
          target="_blank"
          rel="noopener noreferrer"
          className="text-muted-foreground block text-xs hover:underline"
        >
          Learn about cron expressions
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Frequency Select */}
      <Select value={config.frequency} onValueChange={handleFrequencyChange}>
        <SelectTrigger responsive={false} className="h-9" aria-label="Frequency">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {FREQUENCY_OPTIONS.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Time Select — hidden for 15m and hourly */}
      <AnimatePresence initial={false} mode="wait">
        {needsTime && (
          <motion.div
            key="time"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={ANIMATION_TRANSITION}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">at</span>
              <Select value={String(config.hour)} onValueChange={handleHourChange}>
                <SelectTrigger responsive={false} className="h-9 w-32" aria-label="Time">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => (
                    <SelectItem key={i} value={String(i)}>
                      {formatHour(i)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Day pills — weekly only */}
      <AnimatePresence initial={false}>
        {config.frequency === 'weekly' && (
          <motion.div
            key="days"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={ANIMATION_TRANSITION}
            className="overflow-hidden"
          >
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((day) => {
                const isActive = config.days.includes(day.value);
                return (
                  <button
                    key={day.value}
                    type="button"
                    aria-label={day.label}
                    aria-pressed={isActive}
                    className={cn(
                      'rounded-md border px-2.5 py-1 text-xs font-medium transition-colors',
                      isActive
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-input text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    )}
                    onClick={() => handleDayToggle(day.value)}
                  >
                    {day.label}
                  </button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Day of month — monthly only */}
      <AnimatePresence initial={false}>
        {config.frequency === 'monthly' && (
          <motion.div
            key="dom"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={ANIMATION_TRANSITION}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-sm">on day</span>
              <Select value={String(config.dayOfMonth)} onValueChange={handleDayOfMonthChange}>
                <SelectTrigger responsive={false} className="h-9 w-20" aria-label="Day of month">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 31 }, (_, i) => (
                    <SelectItem key={i + 1} value={String(i + 1)}>
                      {ordinal(i + 1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Preview */}
      <p className="text-muted-foreground text-xs">
        {getSimplePreview(config)}
      </p>

      {/* Escape hatch to cron mode */}
      <button
        type="button"
        onClick={switchToCron}
        className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
      >
        Use a cron expression
      </button>
    </div>
  );
}
